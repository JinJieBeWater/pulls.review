import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import type { CommitEvent } from './commits'
import type { Worktree } from './schema'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { upgradeProxy } from './proxy'
import { COOKIE, secret } from './security'
import { createDaemonApp } from './server'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()))
})

async function listen(server: Server): Promise<number> {
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    for (const socket of sockets)
      socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return (server.address() as { port: number }).port
}

async function fixture(port = 1) {
  const tree = { id: 'main-123', path: '/repo', branch: 'main' }
  const registry = { repos: vi.fn(async () => [{ path: '/repo' }]), add: vi.fn(async () => tree), addCurrent: vi.fn(async (): Promise<Worktree | undefined> => tree), find: vi.fn(async (_id: string): Promise<Worktree | undefined> => tree), remove: vi.fn() }
  const children = { get: vi.fn(async () => ({ port, token: 'server-only-token' })) }
  const log = vi.fn()
  const listeners = new Set<(event: CommitEvent) => void>()
  const commits = {
    rescan: vi.fn(async () => {}),
    subscribe: vi.fn((listener: (event: CommitEvent) => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }),
  }
  const root = mkdtempSync(join(tmpdir(), 'pulls-daemon-client-'))
  const client = join(root, 'client')
  mkdirSync(join(client, 'assets'), { recursive: true })
  writeFileSync(join(client, 'shell.html'), '<title>shell</title>')
  writeFileSync(join(client, 'assets', 'shell.js'), 'export {}')
  writeFileSync(join(root, 'pulls-daemon-secret.txt'), 'secret')
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const options = {
    origin: 'http://127.0.0.1:7855',
    session: secret(),
    client,
    stop: vi.fn(),
    log,
    registry,
    children,
    commits,
    connections: new Map<PassThrough, string>(),
  }
  const app = createDaemonApp(options)
  const call = (path: string, init: RequestInit = {}, authenticated = true) => app.fetch(new Request(options.origin + path, {
    ...init,
    headers: {
      host: new URL(options.origin).host,
      ...(authenticated ? { cookie: `${COOKIE}=${options.session}` } : {}),
      ...init.headers,
    },
  }))
  return { app, options, call, registry, children, commits, listeners, log }
}

it('protects every HTTP surface, exchanges launch links once and never logs credentials', async () => {
  const { call, log } = await fixture()
  for (const path of ['/', '/sw.js', '/assets/shell.js', '/api/events', '/api/status', '/api/repos', '/r/main-123/', '/r/main-123/__connection.json'])
    expect((await call(path, {}, false)).status).toBe(401)
  expect((await call('/manifest.webmanifest', {}, false)).status).toBe(200)
  expect((await call('/', { headers: { host: 'evil.test' } })).status).toBe(403)
  expect((await call('/', { headers: { origin: 'null' } })).status).toBe(403)
  expect((await call('/api/launch', { method: 'POST', body: '{}' })).status).toBe(403)
  expect((await call('/api/launch', { method: 'POST', headers: { origin: 'http://127.0.0.1:7855' }, body: '{}' })).status).toBe(400)
  const launch = await call('/api/launch', { method: 'POST', headers: { origin: 'http://127.0.0.1:7855' }, body: JSON.stringify({ path: '/repo' }) })
  const { url } = await launch.json()
  const loginPath = new URL(url).pathname + new URL(url).search
  const login = await call(loginPath, {}, false)
  expect(login.status).toBe(303)
  expect(login.headers.get('location')).toBe('/r/main-123/')
  expect(login.headers.get('set-cookie')).toMatch(/; HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000$/)
  expect(login.headers.get('referrer-policy')).toBe('no-referrer')
  expect((await call(loginPath, {}, false)).status).toBe(401)
  expect(JSON.stringify(log.mock.calls)).not.toContain(new URL(url).searchParams.get('token'))
  const page = await call('/api/launch', { method: 'POST', headers: { origin: 'http://127.0.0.1:7855' }, body: JSON.stringify({ path: '/repo', page: '/branch/fix' }) })
  expect((await page.json()).path).toBe('/r/main-123/branch/fix')
  expect((await call('/api/launch', { method: 'POST', headers: { origin: 'http://127.0.0.1:7855' }, body: JSON.stringify({ path: '/repo', page: 'evil.test' }) })).status).toBe(400)
})

it('refuses launches outside a checkout and serves the tab shell with only its own files', async () => {
  const { call, options, registry } = await fixture()
  registry.addCurrent.mockResolvedValueOnce(undefined)
  const request = { method: 'POST', headers: { origin: options.origin }, body: JSON.stringify({ path: '/not-a-repo' }) }
  expect((await call('/api/launch', request)).status).toBe(422)
  registry.add.mockRejectedValueOnce(new Error('Not a git repository'))
  expect((await call('/api/repos', request)).status).toBe(400)

  expect(await (await call('/')).text()).toBe('<title>shell</title>')
  const asset = await call('/assets/shell.js')
  expect(asset.headers.get('content-type')).toMatch(/javascript/)
  expect(await asset.text()).toBe('export {}')
  expect((await call('/sw.js')).headers.get('content-type')).toMatch(/javascript/)
  for (const path of ['/assets/missing.js', '/assets/%2e%2e%2f%2e%2e%2fpulls-daemon-secret.txt', '/assets/..%2f..%2fpulls-daemon-secret.txt'])
    expect((await call(path)).status).toBe(404)
})

it('streams commits to each open shell until it goes away', async () => {
  const { call, listeners } = await fixture()
  const response = await call('/api/events')
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const reader = response.body!.getReader()
  const read = async () => new TextDecoder().decode((await reader.read()).value)
  expect(await read()).toBe(': connected\n\n')
  const event = { id: 'main-123', repo: '/repo', branch: 'main', sha: 'abc', subject: 'Fix it' }
  for (const listener of listeners)
    listener(event)
  expect(await read()).toBe(`data: ${JSON.stringify(event)}\n\n`)
  await reader.cancel()
  expect(listeners.size).toBe(0)
})

it('serves the shell for a review opened in the address bar and shows launches in open shells', async () => {
  const { call, children } = await fixture()
  expect(await (await call('/r/main-123/worktree', { headers: { 'sec-fetch-dest': 'document' } })).text()).toBe('<title>shell</title>')
  expect(children.get).not.toHaveBeenCalled()
  const launch = async (body: unknown) => (await call('/api/launch', { method: 'POST', headers: { origin: 'http://127.0.0.1:7855' }, body: JSON.stringify(body) })).json()
  expect((await launch({ path: '/repo', show: true })).shown).toBe(false)
  const reader = (await call('/api/events')).body!.getReader()
  const read = async () => new TextDecoder().decode((await reader.read()).value)
  await read()
  expect((await launch({ path: '/repo' })).shown).toBe(false)
  expect((await launch({ path: '/repo', page: '/worktree', show: true })).shown).toBe(true)
  expect(await read()).toBe('event: show\ndata: "/r/main-123/worktree"\n\n')
  await reader.cancel()
})

it('disconnects removed registrations without stopping their worktree servers or other tunnels', async () => {
  const { call, options, registry } = await fixture()
  const removed = new PassThrough()
  const retained = new PassThrough()
  options.connections.set(removed, 'removed')
  options.connections.set(retained, 'retained')
  registry.find.mockImplementation(async id => id === 'retained' ? { id, path: '/retained', branch: 'main' } : undefined)
  const response = await call('/api/repos', {
    method: 'DELETE',
    headers: { origin: options.origin },
    body: JSON.stringify({ path: '/repo' }),
  })
  expect(response.status).toBe(200)
  expect(registry.remove).toHaveBeenCalledWith('/repo')
  expect(removed.destroyed).toBe(true)
  expect(retained.destroyed).toBe(false)
  retained.destroy()
})

it('proxies HTTP under the original base without forwarding the shell cookie', async () => {
  const incoming = vi.fn()
  const port = await listen(createServer((req, res) => {
    incoming(req.url, req.headers)
    res.writeHead(201, { 'Content-Type': 'text/plain' })
    req.pipe(res)
  }))
  const { call, registry } = await fixture(port)
  const reply = await call('/r/main-123/compare/main...feature?q=1', {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:7855' },
    body: 'patch',
  })
  expect(reply.status).toBe(201)
  expect(await reply.text()).toBe('patch')
  expect(incoming.mock.calls[0][0]).toBe('/r/main-123/compare/main...feature?q=1')
  expect(incoming.mock.calls[0][1].cookie).toBeFalsy()
  registry.find.mockResolvedValueOnce(undefined)
  expect((await call('/r/main-123/')).status).toBe(404)
})

it('authenticates WS upgrades, injects only the server token, and forwards the byte stream', async () => {
  const incoming = vi.fn()
  const upstream = createServer()
  upstream.on('upgrade', (req, socket) => {
    incoming(req.url, req.headers)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', bytes => socket.write(bytes))
  })
  const port = await listen(upstream)
  const { options, registry, log } = await fixture(port)
  const shell = createServer()
  shell.on('upgrade', (req, socket, head) => {
    void upgradeProxy(req, socket, head, options)
  })
  const shellPort = await listen(shell)
  options.origin = `http://127.0.0.1:${shellPort}`
  const upgrade = (headers: Record<string, string>, path = '/r/main-123/__ws') => new Promise<number>((resolve, reject) => {
    const req = request(options.origin + path, {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', ...headers },
    })
    req.once('error', reject)
    req.once('response', (reply) => {
      reply.resume()
      resolve(reply.statusCode!)
    })
    req.once('upgrade', (reply, socket) => {
      socket.once('data', (data) => {
        expect(data.toString()).toBe('stream')
        socket.destroy()
        resolve(reply.statusCode!)
      })
      socket.write('stream')
    })
    req.end()
  })
  const headers = { Origin: options.origin, Cookie: `${COOKIE}=${options.session}` }
  expect(await upgrade({ Origin: options.origin })).toBe(401)
  expect(await upgrade({ ...headers, Host: 'evil.test' })).toBe(403)
  expect(await upgrade({ Cookie: headers.Cookie })).toBe(403)
  expect(await upgrade({ ...headers, Origin: 'https://evil.test' })).toBe(403)
  expect(await upgrade(headers, '/r/main-123/not-ws')).toBe(404)
  expect(await upgrade(headers, '/r/main-123/__ws?devframe_auth_token=browser-token')).toBe(101)
  const [path, forwarded] = incoming.mock.calls[0]
  expect(new URL(path, options.origin).searchParams.get('devframe_auth_token')).toBe('server-only-token')
  expect(forwarded.cookie).toBeUndefined()
  expect(forwarded.origin).toBe(`http://127.0.0.1:${port}`)
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/server-only-token|browser-token/)
  registry.find.mockResolvedValueOnce(undefined)
  expect(await upgrade(headers)).toBe(404)
})
