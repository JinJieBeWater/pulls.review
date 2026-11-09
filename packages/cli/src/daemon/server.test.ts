import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import type { CommitEvent } from './commits'
import type { Worktree } from './schema'
import type { SharedSettings } from './settings'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { detectAgents } from '../agents'
import { upgradeProxy } from './proxy'
import { COOKIE, secret } from './security'
import { createDaemonApp } from './server'
import { defaultLocale } from './settings'

vi.mock('../agents', () => ({ detectAgents: vi.fn() }))

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
  const send = vi.fn()
  const children = { get: vi.fn(async () => ({ port, token: 'server-only-token', send, running: vi.fn(async () => ({})) })), peek: vi.fn(() => undefined) }
  let stored: SharedSettings = {}
  const settings = { read: vi.fn(async () => stored), write: vi.fn(async (next: SharedSettings) => void (stored = next)) }
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
    settings,
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
  return { app, options, call, registry, children, send, settings, commits, listeners, log }
}

it('protects every HTTP surface, exchanges launch links once and never logs credentials', async () => {
  const { call, log } = await fixture()
  for (const path of ['/', '/sw.js', '/assets/shell.js', '/api/events', '/api/status', '/api/repos', '/api/settings', '/api/agents', '/r/main-123/', '/r/main-123/__connection.json'])
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
  const manifest = await (await call('/manifest.webmanifest', {}, false)).json()
  expect(manifest.launch_handler).toEqual({ client_mode: 'focus-existing' })
  expect(manifest.protocol_handlers).toEqual([{ protocol: 'web+pullsreview', url: '/login?token=%s' }])
  for (const path of ['/assets/missing.js', '/assets/%2e%2e%2f%2e%2e%2fpulls-daemon-secret.txt', '/assets/..%2f..%2fpulls-daemon-secret.txt'])
    expect((await call(path)).status).toBe(404)
})

it('keeps the shared settings without API keys, and has a picked local agent analyze a launched ?analyze page', async () => {
  const { call, options, send, settings } = await fixture()
  const write = (body: unknown) => call('/api/settings', { method: 'PUT', headers: { origin: options.origin }, body: JSON.stringify(body) })
  // An unset locale means the system's language, as the app's default; the pane reads which, and a PUT drops it.
  expect(await (await call('/api/settings')).json()).toEqual({ defaultLocale: defaultLocale() })
  expect((await write({ llm: { agent: 'nope' } })).status).toBe(400)
  await write({ locale: 'zh-CN', defaultLocale: 'en', llm: { provider: 'gateway', gatewayToken: 'secret', agent: 'pi', agentModel: '' } })
  expect(await (await call('/api/settings')).json()).toEqual({ locale: 'zh-CN', defaultLocale: defaultLocale(), llm: { provider: 'gateway', agent: 'pi', agentModel: '' } })
  expect(JSON.stringify(settings.write.mock.calls)).not.toContain('secret')
  expect(JSON.stringify(settings.write.mock.calls)).not.toContain('defaultLocale')

  const launch = (page: string) => call('/api/launch', { method: 'POST', headers: { origin: options.origin }, body: JSON.stringify({ path: '/repo', page }) })
  await launch('/branch/fix?analyze')
  await vi.waitFor(() => expect(settings.read).toHaveBeenCalledTimes(3))
  expect(send).not.toHaveBeenCalled()

  await write({ locale: 'zh-CN', llm: { provider: 'local-agent', agent: 'pi', agentModel: 'm' } })
  await launch('/branch/fix')
  await launch('/branch/fix?analyze')
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'analyze', page: '/branch/fix', agent: 'pi', model: 'm', locale: 'zh-CN' }))
  expect(send).toHaveBeenCalledTimes(1)
  // No language set: the system's, as the app's default.
  vi.stubGlobal('navigator', { languages: ['ja-JP'] })
  await write({ llm: { provider: 'local-agent', agent: 'pi', agentModel: 'm' } })
  await launch('/branch/other?analyze')
  await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith({ type: 'analyze', page: '/branch/other', agent: 'pi', model: 'm', locale: 'ja' }))
  expect(await (await call('/api/settings')).json()).toMatchObject({ defaultLocale: 'ja' })
  vi.unstubAllGlobals()
})

it('answers the Herdr pane: validates its requests, says why it cannot analyze, and analyzes again on request', async () => {
  const { call, options, send, settings, registry } = await fixture()
  const post = (path: string, body: unknown) => call(path, { method: 'POST', headers: { origin: options.origin }, body: JSON.stringify(body) })
  expect((await post('/api/review', { path: '/repo', page: '/worktree' })).status).toBe(400)
  expect((await post('/api/review', { path: '/repo', page: '/worktree', colors: { keyword: 'red' } })).status).toBe(400)
  // A large group's paths fit the review request, not the other routes.
  const paths = Array.from({ length: 300 }, (_, i) => `apps/some/deep/folder/file-${i}.ts`)
  expect((await post('/api/review', { path: '/repo', page: '/worktree', colors: {}, rows: paths })).status).not.toBe(413)
  expect((await post('/api/review/analyze', { path: '/repo', page: '/worktree', pad: paths })).status).toBe(413)
  // A git failure reaches the pane as its message.
  const failed = await post('/api/review', { path: '/repo', page: '/worktree', colors: {} })
  expect(failed.status).toBe(500)
  expect(await failed.text()).not.toBe('')

  const analyze = await post('/api/review/analyze', { path: '/repo', page: '/worktree' })
  expect(analyze.status).toBe(409)
  expect(await analyze.text()).toContain('local agent')
  await settings.write({ locale: 'en', llm: { provider: 'local-agent', agent: 'pi', agentModel: '' } })
  expect((await post('/api/review/analyze', { path: '/repo', page: '/worktree', force: true })).status).toBe(200)
  expect(send).toHaveBeenCalledWith({ type: 'analyze', page: '/worktree', agent: 'pi', model: '', locale: 'en', force: true })

  // An unknown worktree is registered on first use, as a launch registers it.
  registry.find.mockResolvedValueOnce(undefined)
  registry.addCurrent.mockResolvedValueOnce(undefined)
  expect((await post('/api/review/analyze', { path: '/elsewhere', page: '/worktree' })).status).toBe(422)
})

it('gives the pane an open\'s first group in one read, and a run\'s status without reading the diff', async () => {
  const { call, options, registry, children } = await fixture()
  // Canonical, as the registry holds a worktree's root.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pulls-daemon-status-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1' } })
  git('init', '-b', 'main')
  writeFileSync(join(root, 'a.ts'), 'const a = 1\n')
  git('add', '.')
  git('commit', '-m', 'initial')
  writeFileSync(join(root, 'a.ts'), 'const a = 22\n')
  const tree = { id: 'main-123', path: root, branch: 'main' }
  registry.find.mockResolvedValue(tree)
  const post = (path: string, body: unknown) => call(path, { method: 'POST', headers: { origin: options.origin }, body: JSON.stringify({ path: root, ...body as object }) })

  const opened = await (await post('/api/review', { page: '/worktree', colors: {}, rows: [], firstRows: true })).json()
  expect(opened.files.map((file: { path: string, hunks?: unknown }) => [file.path, !!file.hunks])).toEqual([['a.ts', true]])
  // A later batch's rows come on their own, from the diff the open read; a page past its last row has none.
  const rows = { page: '/worktree', colors: {}, files: ['a.ts'], base: opened.base.sha, head: opened.head.sha }
  expect(await (await post('/api/review/rows', rows)).json()).toEqual({ files: [{ path: 'a.ts', sha: opened.files[0].sha, hunks: opened.files[0].hunks }] })
  expect(await (await post('/api/review/rows', { ...rows, from: 2 })).json()).toEqual({ files: [{ path: 'a.ts', sha: opened.files[0].sha, hunks: [] }] })
  expect((await post('/api/review/rows', { ...rows, from: -1 })).status).toBe(400)
  expect((await post('/api/review/rows', { ...rows, files: Array.from({ length: 300 }, (_, i) => `apps/some/deep/folder/file-${i}.ts`) })).status).toBe(200)

  // A range git can't resolve: a read of its diff fails, its status doesn't. No server started yet: nothing runs.
  expect((await post('/api/review', { page: '/compare/nope...gone', colors: {} })).status).toBe(500)
  const status = await post('/api/review/status', { page: '/compare/nope...gone' })
  expect(status.status).toBe(200)
  expect(await status.json()).toEqual({ running: false })
  expect(children.get).not.toHaveBeenCalled()

  const running = vi.fn(async () => ({ streamId: 's', progress: { step: 1, kind: 'thinking' as const } }))
  children.peek.mockReturnValue({ running } as never)
  expect(await (await post('/api/review/status', { page: '/worktree' })).json()).toEqual({ running: true, progress: { step: 1, kind: 'thinking' } })
  expect(running).toHaveBeenCalledWith(opened.key)
  expect(children.peek).toHaveBeenCalledWith(tree)
  expect((await post('/api/review/status', { page: '/elsewhere' })).status).toBe(400)

  // A server that doesn't answer: the status is an error, not a finished run, and a read says why.
  running.mockRejectedValue(new Error('Worktree server did not answer'))
  const lost = await post('/api/review/status', { page: '/worktree' })
  expect([lost.status, await lost.text()]).toEqual([500, 'Worktree server did not answer'])
  expect((await (await post('/api/review', { page: '/worktree', colors: {}, rows: [] })).json()).analysis.error).toBe('Can\'t tell whether an analysis runs: Worktree server did not answer')
})

it('exchanges a PWA launch token for a cookie and page without navigating the shell', async () => {
  const { call, options } = await fixture()
  const response = await call('/api/launch', { method: 'POST', headers: { origin: options.origin }, body: JSON.stringify({ path: '/repo', page: '/worktree' }) })
  const { url } = await response.json()
  const token = new URL(url).searchParams.get('token')
  const loginPath = `/login?token=${encodeURIComponent(`web+pullsreview:${token}`)}`
  const login = await call(loginPath, { headers: { accept: 'application/json' } }, false)
  expect(login.status).toBe(200)
  expect(await login.json()).toEqual({ path: '/r/main-123/worktree' })
  expect(login.headers.get('set-cookie')).toMatch(/; HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000$/)
  expect((await call(loginPath, { headers: { accept: 'application/json' } }, false)).status).toBe(401)
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

it('serves the shell for a review opened in the address bar', async () => {
  const { call, children } = await fixture()
  expect(await (await call('/r/main-123/worktree', { headers: { 'sec-fetch-dest': 'document' } })).text()).toBe('<title>shell</title>')
  expect(children.get).not.toHaveBeenCalled()
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

it('answers /api/agents with the last agents found, and finds them again for the next ask', async () => {
  const { call } = await fixture()
  const first = [{ name: 'pi' as const, label: 'Pi', version: '1', models: [] }]
  const second = [...first, { name: 'codex' as const, label: 'Codex', version: '2', models: [{ id: 'gpt', name: 'GPT' }] }]
  vi.mocked(detectAgents).mockResolvedValueOnce(first).mockResolvedValue(second)
  expect(await (await call('/api/agents')).json()).toEqual(first)
  // Still the last list, while the second look runs; then what it found.
  expect(await (await call('/api/agents')).json()).toEqual(first)
  expect(await (await call('/api/agents')).json()).toEqual(second)
})
