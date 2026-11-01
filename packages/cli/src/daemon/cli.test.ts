import { EventEmitter } from 'node:events'
import process from 'node:process'
import { open as openBrowser } from 'devframe/utils/open'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { routeDaemon } from './cli'
import { readState } from './state'

const connection = vi.hoisted(() => ({ occupied: false }))
vi.mock('devframe/utils/open', () => ({ open: vi.fn(async () => {}) }))
vi.mock('node:net', () => ({
  createConnection() {
    const socket = new EventEmitter()
    Object.defineProperty(socket, 'destroy', { value: vi.fn() })
    queueMicrotask(() => connection.occupied ? socket.emit('connect') : socket.emit('error', { code: 'ECONNREFUSED' }))
    return socket
  },
}))
vi.mock('./state', () => ({
  readState: vi.fn(),
  daemonOrigin: (port: number) => `http://127.0.0.1:${port}`,
  stateDir: () => { throw new Error('This test must never write daemon state') },
}))

beforeEach(() => {
  connection.occupied = false
  vi.mocked(readState).mockResolvedValue(undefined)
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  vi.mocked(openBrowser).mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.mocked(readState).mockReset()
})

it('rejects stop targets, contradictory modes and invalid ports before starting anything', async () => {
  await expect(routeDaemon({ daemon: true, stop: true }, [])).rejects.toThrow('cannot be combined')
  await expect(routeDaemon({ stop: true }, ['main'])).rejects.toThrow('--stop takes no target')
  await expect(routeDaemon({ daemon: true, from: 'antfu' }, [])).rejects.toThrow('does not take --from')
  for (const port of ['0', '1.5', '65536'])
    await expect(routeDaemon({ daemon: true, port }, [])).rejects.toThrow('--port must be')
  expect(readState).not.toHaveBeenCalled()
})

it('does not treat a foreign listener as the daemon or pick another port', async () => {
  connection.occupied = true
  await expect(routeDaemon({ daemon: true, port: '12345' }, [])).rejects.toThrow('already in use by another program')
})

it('can stop an absent daemon without creating state', async () => {
  await routeDaemon({ stop: true, port: '12345' }, [])
  expect(process.stdout.write).toHaveBeenCalledWith('pulls.review daemon is not running\n')
})

it('uses the authenticated pid record to stop a custom-port daemon', async () => {
  const state = { pid: 1234, port: 12345, session: 'a'.repeat(64) }
  vi.mocked(readState).mockResolvedValueOnce(state).mockResolvedValueOnce(state).mockResolvedValue(undefined)
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ pid: state.pid })).mockResolvedValueOnce(Response.json({ stopping: true }))
  vi.stubGlobal('fetch', fetch)
  await routeDaemon({ stop: true }, [])
  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:12345/api/stop', expect.objectContaining({
    method: 'POST',
    headers: { 'Cookie': `pulls_session=${state.session}`, 'Origin': 'http://127.0.0.1:12345', 'Content-Type': 'application/json' },
  }))
  expect(process.stdout.write).toHaveBeenCalledWith('pulls.review daemon stopped\n')
})

function mockLaunch(path = '/r/repo-123/') {
  const state = { pid: 1234, port: 12345, session: 'a'.repeat(64) }
  const url = 'http://127.0.0.1:12345/login?token=private-launch-credential'
  vi.mocked(readState).mockResolvedValue(state)
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ pid: state.pid }))
    .mockResolvedValueOnce(Response.json({ url, path })))
  return url
}

it('opens the one-time login URL, or prints it to stderr with --no-open', async () => {
  const url = mockLaunch()
  await routeDaemon({ daemon: true, port: '12345' }, [])
  expect(openBrowser).toHaveBeenCalledWith(url)
  expect(process.stdout.write).toHaveBeenCalledWith('pulls.review daemon: http://127.0.0.1:12345/r/repo-123/\n')
  mockLaunch()
  await routeDaemon({ 'daemon': true, 'port': '12345', 'no-open': true }, [])
  expect(process.stderr.write).toHaveBeenCalledWith(`One-time login credential (expires in 60 seconds): ${url}\n`)
  expect(process.stdout.write).not.toHaveBeenCalledWith(expect.stringContaining('token='))
})

it('launches the page the foreground command would open', async () => {
  mockLaunch('/r/repo-123/worktree')
  await routeDaemon({ daemon: true, port: '12345', worktree: true }, [])
  expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)).toEqual({ path: process.cwd(), page: '/worktree' })
})

it('refuses to open a daemon review outside a git repository', async () => {
  mockLaunch()
  vi.mocked(fetch).mockReset().mockResolvedValueOnce(Response.json({ pid: 1234 })).mockResolvedValueOnce(new Response('Not a git repository', { status: 422 }))
  await expect(routeDaemon({ daemon: true, port: '12345' }, [])).rejects.toThrow('Not a git repository')
  expect(openBrowser).not.toHaveBeenCalled()
})
