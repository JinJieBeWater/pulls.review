import type { Buffer } from 'node:buffer'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WorktreeServers } from './children'
import type { RepoRegistry } from './registry'
import { request } from 'node:http'
import { hasSession, requestGuard } from './security'

export type AccessLog = (method: string, path: string, status: number) => void

export function routeId(path: string): string | undefined {
  return /^\/r\/([\w-]+)\//.exec(path)?.[1]
}

export async function upgradeProxy(req: IncomingMessage, socket: Duplex, head: Buffer, options: {
  origin: string
  session: string
  registry: Pick<RepoRegistry, 'find'>
  children: Pick<WorktreeServers, 'get'>
  connections: Map<Duplex, string>
  log: AccessLog
}): Promise<void> {
  const { origin, session, registry, children, connections, log } = options
  const url = new URL(req.url || '/', origin)
  const reject = (status: number) => {
    log(req.method || 'GET', url.pathname, status)
    socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`)
  }
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined)
      headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  const invalid = requestGuard(headers, req.method || 'GET', origin, true)
  if (invalid)
    return reject(invalid)
  if (!hasSession(headers, session))
    return reject(401)
  const id = routeId(url.pathname)
  if (!id || url.pathname !== `/r/${id}/__ws`)
    return reject(404)
  connections.set(socket, id)
  socket.once('close', () => connections.delete(socket))
  const tree = await registry.find(id)
  if (!tree)
    return reject(404)
  const target = await children.get(tree)
  if (socket.destroyed)
    return
  const childOrigin = `http://127.0.0.1:${target.port}`
  url.searchParams.set('devframe_auth_token', target.token)
  const forwarded = { ...req.headers, host: new URL(childOrigin).host, origin: childOrigin }
  delete forwarded.cookie
  delete forwarded.authorization
  const upstream = request({
    host: '127.0.0.1',
    port: target.port,
    path: url.pathname + url.search,
    headers: forwarded,
  })
  socket.once('error', () => upstream.destroy())
  socket.once('close', () => upstream.destroy())
  upstream.once('upgrade', (response, remote, remoteHead) => {
    log(req.method || 'GET', url.pathname, response.statusCode || 101)
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`)
    for (let i = 0; i < response.rawHeaders.length; i += 2)
      socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`)
    socket.write('\r\n')
    if (remoteHead.length)
      socket.write(remoteHead)
    if (head.length)
      remote.write(head)
    socket.pipe(remote).pipe(socket)
    socket.once('close', () => remote.destroy())
    remote.once('close', () => socket.destroy())
    remote.once('error', () => socket.destroy())
  })
  upstream.once('response', (response) => {
    response.resume()
    reject(502)
  })
  upstream.once('error', () => {
    if (!socket.destroyed)
      reject(502)
  })
  upstream.end()
}
