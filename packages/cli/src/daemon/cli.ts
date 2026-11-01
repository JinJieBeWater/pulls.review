import type { DaemonState } from './schema'
import { fork } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { open as openBrowser } from 'devframe/utils/open'
import * as v from 'valibot'
import { browserPath, pageFor } from '../page'
import { DaemonMessageSchema, LaunchSchema, StatusSchema } from './schema'
import { COOKIE } from './security'
import { daemonOrigin, readState, stateDir } from './state'

async function control(state: DaemonState, path: string, body?: unknown): Promise<Response> {
  const origin = daemonOrigin(state.port)
  return fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Cookie': `${COOKIE}=${state.session}`, 'Origin': origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  })
}

async function occupied(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error))
  })
}

async function running(port: number): Promise<DaemonState | undefined> {
  const state = await readState()
  if (state) {
    try {
      const response = await control(state, '/api/status')
      if (response.ok && v.parse(StatusSchema, await response.json()).pid === state.pid) {
        if (state.port !== port)
          throw new Error(`Daemon is already running on port ${state.port}`)
        return state
      }
    }
    catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException))
        throw error
    }
  }
  if (await occupied(port))
    throw new Error(`Port ${port} is already in use by another program`)
}

async function start(port: number): Promise<DaemonState> {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 })
  const log = await open(join(stateDir(), 'daemon.log'), 'a', 0o600)
  try {
    await log.chmod(0o600)
    return await new Promise<DaemonState>((resolve, reject) => {
      const child = fork(new URL('./daemon-process.mjs', import.meta.url), [], {
        detached: true,
        stdio: ['ignore', log.fd, log.fd, 'ipc'],
      })
      const timer = setTimeout(() => fail(new Error('Daemon startup timed out')), 15_000)
      let settled = false
      function fail(error: Error) {
        if (settled)
          return
        settled = true
        clearTimeout(timer)
        child.kill('SIGTERM')
        reject(error)
      }
      child.once('error', fail)
      child.once('exit', (exitCode, signal) => fail(new Error(`Daemon exited during startup (${signal ?? `exit ${exitCode}`})`)))
      child.once('message', (raw: unknown) => {
        try {
          const message = v.parse(DaemonMessageSchema, raw)
          if (message.type === 'error') {
            fail(new Error(`Daemon failed to start: ${message.message}`))
            return
          }
          settled = true
          clearTimeout(timer)
          child.disconnect()
          child.unref()
          resolve({ pid: message.pid, port: message.port, session: message.session })
        }
        catch (error) {
          fail(error as Error)
        }
      })
      child.send({ port })
    })
  }
  finally {
    await log.close()
  }
}

async function launch(state: DaemonState, page: string, noOpen: boolean): Promise<void> {
  const response = await control(state, '/api/launch', { path: process.cwd(), page })
  if (response.status === 422)
    throw new Error('Not a git repository: run pulls.review -d inside one')
  if (!response.ok)
    throw new Error('Could not register current git worktree')
  const { url, path } = v.parse(LaunchSchema, await response.json())
  process.stdout.write(`pulls.review daemon: ${daemonOrigin(state.port)}${path}\n`)
  if (noOpen)
    process.stderr.write(`One-time login credential (expires in 60 seconds): ${url}\n`)
  else
    await openBrowser(url)
}

async function stop(state: DaemonState | undefined, port: number): Promise<void> {
  if (!state) {
    process.stdout.write('pulls.review daemon is not running\n')
    return
  }
  const response = await control(state, '/api/stop', {})
  if (!response.ok)
    throw new Error('Could not stop daemon')
  for (let attempt = 0; attempt < 100; attempt++) {
    // The listener closes before child cleanup finishes.
    if (!await occupied(port) && (await readState())?.pid !== state.pid) {
      process.stdout.write('pulls.review daemon stopped\n')
      return
    }
    await delay(50)
  }
  throw new Error('Daemon shutdown timed out')
}

export async function routeDaemon(flags: {
  'daemon'?: boolean
  'stop'?: boolean
  'port'?: string
  'worktree'?: boolean
  'from'?: string
  'no-open'?: boolean
}, positionals: string[]): Promise<void> {
  if (flags.daemon && flags.stop)
    throw new Error('--daemon and --stop cannot be combined')
  if (flags.from !== undefined || (flags.stop && (flags.worktree || positionals.length)))
    throw new Error('--stop takes no target, and --daemon does not take --from')
  const port = flags.port === undefined && flags.stop ? (await readState())?.port || 7855 : Number(flags.port ?? 7855)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('--port must be an integer between 1 and 65535')
  // Same page as the foreground command; fails on a malformed target before the daemon starts.
  const page = flags.stop ? '/' : browserPath(await pageFor(process.cwd(), positionals[0], !!flags.worktree))
  let state = await running(port)
  if (flags.stop)
    return stop(state, port)
  if (!state) {
    try {
      state = await start(port)
    }
    catch (error) {
      state = await running(port)
      if (!state)
        throw error
    }
  }
  await launch(state, page, !!flags['no-open'])
}
