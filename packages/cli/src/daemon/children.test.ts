import { ChildProcess, fork } from 'node:child_process'
import process from 'node:process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorktreeServers, signalGroup } from './children'

vi.mock('node:child_process', async (original) => {
  const module = await original<typeof import('node:child_process')>()
  return { ...module, fork: vi.fn() }
})

const tree = { id: 'repo-123', path: '/repo', branch: 'main' }

function child(pid: number) {
  const process = new ChildProcess()
  const send = vi.fn()
  Object.defineProperty(process, 'pid', { value: pid })
  Object.defineProperty(process, 'send', { value: send })
  vi.mocked(fork).mockReturnValueOnce(process)
  return { process, send }
}

beforeEach(() => {
  vi.spyOn(process, 'kill').mockReturnValue(true)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(fork).mockReset()
  vi.useRealTimers()
})

it('starts one server per worktree with a private IPC token and the correct cwd', async () => {
  const { process: first, send } = child(12345)
  const servers = createWorktreeServers()
  const ready = servers.get(tree)
  expect(servers.get(tree)).toBe(ready)
  expect(fork).toHaveBeenCalledTimes(1)
  expect(fork).toHaveBeenCalledWith(expect.any(URL), [], {
    cwd: tree.path,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  expect(send).toHaveBeenCalledWith({ token: expect.stringMatching(/^[a-f0-9]{64}$/), basePath: '/r/repo-123/' })
  first.emit('message', { type: 'ready', port: 1234 })
  expect(await ready).toEqual({ port: 1234, token: send.mock.calls[0][0].token })
  first.emit('exit', 0)
  expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGKILL')
})

it('does not lose a replacement when the previous failed child exits late', async () => {
  const { process: old } = child(12345)
  const servers = createWorktreeServers()
  const failed = servers.get(tree)
  old.emit('message', { type: 'error', message: 'EACCES' })
  await expect(failed).rejects.toThrow('EACCES')
  const { process: next } = child(12346)
  const replacement = servers.get(tree)
  old.emit('exit', 1)
  expect(servers.get(tree)).toBe(replacement)
  expect(fork).toHaveBeenCalledTimes(2)
  next.emit('message', { type: 'ready', port: 1234 })
  await replacement
  next.emit('exit', 0)
})

it('kills timed-out startup groups and rejects new work during shutdown', async () => {
  vi.useFakeTimers()
  const { process: first } = child(12345)
  const servers = createWorktreeServers()
  const ready = expect(servers.get(tree)).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(30_000)
  await ready
  expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGKILL')
  first.emit('exit', 1)
  await servers.close()
  await expect(servers.get(tree)).rejects.toThrow('stopping')
})

it('signals entire groups, waits for children and escalates for remaining descendants', async () => {
  const { process: first } = child(12345)
  const servers = createWorktreeServers()
  const ready = servers.get(tree)
  first.emit('message', { type: 'ready', port: 1234 })
  await ready
  vi.mocked(process.kill).mockImplementation((_, signal) => {
    if (signal === 'SIGTERM')
      queueMicrotask(() => first.emit('exit', 0))
    return true
  })
  await servers.close()
  expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGTERM')
  expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGKILL')
})

it.runIf(process.platform === 'darwin')('finishes shutdown when an exited child group has only dying members', async () => {
  const { process: first } = child(12345)
  const servers = createWorktreeServers()
  const ready = servers.get(tree)
  first.emit('message', { type: 'ready', port: 1234 })
  await ready
  vi.mocked(process.kill).mockImplementation((_, signal) => {
    if (signal === 'SIGTERM') {
      queueMicrotask(() => {
        Object.defineProperty(first, 'signalCode', { value: 'SIGTERM' })
        expect(() => first.emit('exit', null, 'SIGTERM')).not.toThrow()
      })
      return true
    }
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
  })
  await expect(servers.close()).resolves.toBeUndefined()
  expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGKILL')
})

it('does not hide permission errors for live children or other signal errors', () => {
  const { process: first } = child(12345)
  for (const code of ['EPERM', 'EINVAL']) {
    const error = Object.assign(new Error(`kill ${code}`), { code })
    vi.mocked(process.kill).mockImplementation(() => {
      throw error
    })
    expect(() => signalGroup(first, 'SIGTERM')).toThrow(error)
  }
  Object.defineProperty(first, 'signalCode', { value: 'SIGTERM' })
  expect(() => signalGroup(first, 'SIGKILL')).toThrow('EINVAL')
})
