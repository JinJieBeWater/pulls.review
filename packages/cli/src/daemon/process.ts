import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { toNodeHandler } from 'h3/node'
import * as v from 'valibot'
import { createWorktreeServers } from './children'
import { watchCommits } from './commits'
import { upgradeProxy } from './proxy'
import { atomicWrite, createRepoRegistry } from './registry'
import { DaemonStartSchema } from './schema'
import { createDaemonApp } from './server'
import { daemonOrigin, loadSession, pidFile, readState, stateDir } from './state'

process.umask(0o077)
process.once('message', async (message: unknown) => {
  const children = createWorktreeServers()
  try {
    const { port } = v.parse(DaemonStartSchema, message)
    const session = await loadSession()
    const origin = daemonOrigin(port)
    const registry = createRepoRegistry(join(stateDir(), 'repos.json'))
    const commits = watchCommits(registry)
    void commits.rescan()
    const sockets = new Set<Socket>()
    const connections = new Map<Duplex, string>()
    let stopping = false
    const log = (method: string, path: string, status: number) => process.stdout.write(`${method} ${JSON.stringify(path)} ${status}\n`)
    const app = createDaemonApp({
      origin,
      session,
      client: fileURLToPath(new URL('./client', import.meta.url)),
      registry,
      children,
      commits,
      connections,
      stop: () => { void stop() },
      log,
    })
    const server = createServer(toNodeHandler(app))
    async function stop() {
      if (stopping)
        return
      stopping = true
      server.close()
      for (const socket of sockets)
        socket.destroy()
      await Promise.all([children.close(), commits.close()])
      if ((await readState())?.pid === process.pid)
        await rm(pidFile(), { force: true })
      process.exit()
    }
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => socket.destroy())
      void upgradeProxy(req, socket, head, { origin, session, registry, children, connections, log }).catch(() => {
        log(req.method || 'GET', new URL(req.url || '/', origin).pathname, 502)
        socket.end('HTTP/1.1 502 Rejected\r\nConnection: close\r\n\r\n')
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    await atomicWrite(pidFile(), { pid: process.pid, port, session })
    process.on('SIGTERM', () => {
      void stop()
    })
    process.on('SIGINT', () => {
      void stop()
    })
    process.send?.({ type: 'ready', pid: process.pid, port, session })
  }
  catch (error) {
    await children.close()
    process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) }, () => process.exit(1))
  }
})
