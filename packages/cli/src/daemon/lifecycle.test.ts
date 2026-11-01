import type { DaemonState } from './schema'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import * as v from 'valibot'
import { expect, it, vi } from 'vitest'
import { DaemonStateSchema } from './schema'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../../bin.mjs', import.meta.url))

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
      return false
    throw error
  }
}

async function descendants(pid: number) {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid='])
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
  const pids = [pid]
  for (let i = 0; i < pids.length; i++)
    pids.push(...rows.filter(row => row[1] === pids[i]).map(row => row[0]!))
  return pids
}

// Opt in after the complete CLI build: PULLS_DAEMON_SMOKE=1 pnpm exec vitest run src/daemon/lifecycle.test.ts
it.runIf(process.env.PULLS_DAEMON_SMOKE === '1')('starts built workers, reuses the daemon and stops every process', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulls-lifecycle-')))
  const home = join(root, 'home')
  const main = join(root, 'main')
  const linked = join(root, 'linked')
  await mkdir(home)
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', PATH: '/usr/bin:/bin' }
  delete env.GITHUB_TOKEN
  delete env.GH_TOKEN
  delete env.NODE_OPTIONS
  const git = (args: string[], cwd = root) => exec('git', args, { cwd, env })
  const run = (args: string[], cwd = main) => exec(process.execPath, [cli, ...args], { cwd, env, timeout: 30_000 })
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP port')
  const port = address.port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  expect(port).not.toBe(7855)
  const origin = `http://127.0.0.1:${port}`
  const pidFile = join(home, '.pulls.review', 'daemon.pid')
  let state: DaemonState | undefined
  let pids: number[] = []
  try {
    await git(['init', '-q', '-b', 'main', main])
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'initial'], main)
    await git(['worktree', 'add', '-b', 'feature', linked], main)
    const first = await run(['-d', '--no-open', '--port', String(port)])
    state = v.parse(DaemonStateSchema, JSON.parse(await readFile(pidFile, 'utf8')))
    expect(state.port).toBe(port)
    expect(alive(state.pid)).toBe(true)
    expect((await stat(pidFile)).mode & 0o777).toBe(0o600)
    expect(first.stdout.includes('token=')).toBe(false)
    const login = first.stderr.match(/http:\/\/127\.0\.0\.1:\d+\/login\?token=[a-f0-9]+/)?.[0]
    if (!login)
      throw new Error('Missing one-time login link')
    const redirect = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(5_000) })
    expect(redirect.status).toBe(303)
    const cookie = redirect.headers.get('set-cookie')?.split(';')[0]
    if (!cookie)
      throw new Error('Missing session cookie')
    // Signed in, the browser lands on this worktree's page, which the tab shell shows.
    const mainPath = new URL(redirect.headers.get('location')!, origin).pathname
    expect(mainPath).toMatch(/^\/r\/[\w-]+\//)
    const second = await run(['-d', '--no-open', '--port', String(port)], linked)
    expect(v.parse(DaemonStateSchema, JSON.parse(await readFile(pidFile, 'utf8')))).toEqual(state)
    expect(JSON.parse(await readFile(join(home, '.pulls.review', 'repos.json'), 'utf8'))).toEqual({ repos: [{ path: main }] })
    const linkedPath = new URL(second.stdout.trim().split(' ').at(-1)!).pathname
    expect(linkedPath).not.toBe(mainPath)
    for (const path of [mainPath, linkedPath]) {
      const response = await fetch(origin + path, { headers: { cookie }, signal: AbortSignal.timeout(30_000) })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain(`<base href="${path.match(/^\/r\/[\w-]+\//)![0]}">`)
    }
    pids = await descendants(state.pid)
    expect(pids.length).toBeGreaterThanOrEqual(3)
    expect((await run(['--stop', '--port', String(port)])).stdout).toContain('daemon stopped')
    await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 5_000 })
    await expect(stat(pidFile)).rejects.toMatchObject({ code: 'ENOENT' })

    // The sign-in survives a restart.
    await run(['-d', '--no-open', '--port', String(port)])
    state = v.parse(DaemonStateSchema, JSON.parse(await readFile(pidFile, 'utf8')))
    expect((await fetch(origin + mainPath, { headers: { cookie }, signal: AbortSignal.timeout(30_000) })).status).toBe(200)
  }
  finally {
    if (state) {
      pids = [...new Set([...pids, ...await descendants(state.pid)])]
      await run(['--stop', '--port', String(port)]).catch(() => {})
      for (const pid of pids) {
        if (alive(pid))
          process.kill(-pid, 'SIGKILL')
      }
      await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 5_000 })
    }
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
