import type { ChildProcess } from 'node:child_process'
import type { RunningState, Worktree, WorktreeAnalyze } from './schema'
import { fork } from 'node:child_process'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import * as v from 'valibot'
import { WorktreeMessageSchema, WorktreeRunningReplySchema } from './schema'
import { secret } from './security'

export interface WorktreeServer {
  port: number
  token: string
  send: (message: WorktreeAnalyze) => void
  /** The analysis running for a cache key, its latest progress, or why the last one failed. */
  running: (key: string) => Promise<RunningState>
}

/** Replies to `running` requests, matched by id; a request the child never answers gives up after 5 s. */
function runningRequests(child: ChildProcess) {
  const pending = new Map<number, (state: RunningState) => void>()
  let next = 0
  child.on('message', (raw: unknown) => {
    const reply = v.safeParse(WorktreeRunningReplySchema, raw)
    if (reply.success)
      pending.get(reply.output.id)?.(reply.output.state)
  })
  return (key: string) => new Promise<RunningState>((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Worktree server did not answer'))
    }, 5_000)
    pending.set(id, (state) => {
      clearTimeout(timer)
      pending.delete(id)
      resolve(state)
    })
    child.send({ type: 'running', id, key })
  })
}

export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid)
    return
  try {
    process.kill(-child.pid, signal)
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH')
      return
    // Darwin can report EPERM while an exited group still has dying members.
    if (code === 'EPERM' && process.platform === 'darwin' && (child.exitCode !== null || child.signalCode !== null))
      return
    throw error
  }
}

export type WorktreeServers = ReturnType<typeof createWorktreeServers>

export function createWorktreeServers() {
  const servers = new Map<string, Promise<WorktreeServer>>()
  const children = new Set<ChildProcess>()
  let stopping = false

  function get(tree: Worktree): Promise<WorktreeServer> {
    if (stopping)
      return Promise.reject(new Error('Daemon is stopping'))
    const existing = servers.get(tree.id)
    if (existing)
      return existing
    const token = secret()
    const child = fork(new URL('./daemon-child.mjs', import.meta.url), [], {
      cwd: tree.path,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    children.add(child)
    const ready = new Promise<WorktreeServer>((resolve, reject) => {
      const timeout = setTimeout(() => {
        signalGroup(child, 'SIGKILL')
        reject(new Error('Worktree server startup timed out'))
      }, 30_000)
      const fail = (error: Error) => {
        clearTimeout(timeout)
        reject(error)
      }
      child.once('error', fail)
      child.once('exit', (exitCode, signal) => fail(new Error(`Worktree server exited during startup (${signal ?? `exit ${exitCode}`})`)))
      child.once('message', (raw: unknown) => {
        try {
          const message = v.parse(WorktreeMessageSchema, raw)
          if (message.type === 'error') {
            signalGroup(child, 'SIGKILL')
            fail(new Error(`Worktree server failed to start: ${message.message}`))
            return
          }
          clearTimeout(timeout)
          resolve({ port: message.port, token, send: request => child.send(request), running: runningRequests(child) })
        }
        catch (error) {
          signalGroup(child, 'SIGKILL')
          fail(error as Error)
        }
      })
    })
    servers.set(tree.id, ready)
    const forget = () => {
      if (servers.get(tree.id) === ready)
        servers.delete(tree.id)
    }
    child.once('exit', () => {
      forget()
      // The process group can still contain an agent after its parent exits.
      signalGroup(child, 'SIGKILL')
      children.delete(child)
    })
    void ready.catch(forget)
    child.send({ token, basePath: `/r/${tree.id}/` })
    return ready
  }

  /** The worktree's server if one is started, without starting one. */
  function peek(tree: Worktree): Promise<WorktreeServer> | undefined {
    return servers.get(tree.id)
  }

  async function close(): Promise<void> {
    stopping = true
    const active = [...children]
    for (const child of active)
      signalGroup(child, 'SIGTERM')
    await Promise.race([
      Promise.all(active.map(child => new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null)
          resolve()
        else
          child.once('exit', () => resolve())
      }))),
      delay(2_000),
    ])
    for (const child of active)
      signalGroup(child, 'SIGKILL')
  }

  return { get, peek, close }
}
