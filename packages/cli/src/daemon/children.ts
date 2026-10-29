import type { ChildProcess } from 'node:child_process'
import type { Worktree } from './schema'
import { fork } from 'node:child_process'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import * as v from 'valibot'
import { WorktreeMessageSchema } from './schema'
import { secret } from './security'

export interface WorktreeServer {
  port: number
  token: string
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
          resolve({ port: message.port, token })
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

  return { get, close }
}
