import type { Duplex } from 'node:stream'
import type { WorktreeServers } from './children'
import type { CommitWatcher } from './commits'
import type { AccessLog } from './proxy'
import type { RepoRegistry } from './registry'
import process from 'node:process'
import { bodyLimit, H3, HTTPError, proxyRequest, readBody } from 'h3'
import * as v from 'valibot'
import { routeId } from './proxy'
import { worktrees } from './registry'
import { COOKIE, createLaunchTokens, hasSession, requestGuard } from './security'
import { createShellFiles, MANIFEST, SERVICE_WORKER } from './shell'

const pathSchema = v.object({ path: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)) })
// The page inside the worktree's review, as `pageFor` picks it.
const launchSchema = v.object({ ...pathSchema.entries, page: v.optional(v.pipe(v.string(), v.startsWith('/'), v.maxLength(4096)), '/'), show: v.optional(v.boolean(), false) })

export function createDaemonApp(options: {
  origin: string
  session: string
  /** The built client: the shell page and its assets. */
  client: string
  registry: Pick<RepoRegistry, 'repos' | 'add' | 'addCurrent' | 'remove' | 'find'>
  children: Pick<WorktreeServers, 'get'>
  commits: Pick<CommitWatcher, 'rescan' | 'subscribe'>
  connections: Map<Duplex, string>
  stop: () => void
  log: AccessLog
}): H3 {
  const { origin, session, registry, children, commits, connections, stop, log } = options
  const launches = createLaunchTokens()
  const shell = createShellFiles(options.client)
  /** Each open shell's event stream, so a launch can show its page in one instead of a new browser tab. */
  const shells = new Set<(text: string) => void>()
  const app = new H3({
    onError: error => new Response('Daemon request failed', { status: error.status }),
    onResponse(response, event) {
      response.headers.set('Cache-Control', 'no-store')
      response.headers.set('Referrer-Policy', 'no-referrer')
      response.headers.set('X-Content-Type-Options', 'nosniff')
      log(event.req.method, event.url.pathname, response.status)
    },
  })
  app.use(async (event, next) => {
    const invalid = requestGuard(event.req.headers, event.req.method, origin)
    if (invalid)
      return new Response('Forbidden', { status: invalid })
    if (event.url.pathname === '/login' && event.req.method === 'GET') {
      const path = launches.consume(event.url.searchParams.get('token') || '')
      if (!path)
        return new Response('Invalid or expired launch token', { status: 401 })
      return new Response(null, {
        status: 303,
        // A year: the session secret survives restarts (`loadSession`), so an installed app stays signed in.
        headers: { 'Set-Cookie': `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, 'Location': path },
      })
    }
    // Fetched without the cookie by the browser's install check.
    if (event.url.pathname === '/manifest.webmanifest' && event.req.method === 'GET')
      return new Response(MANIFEST, { headers: { 'Content-Type': 'application/manifest+json' } })
    if (!hasSession(event.req.headers, session))
      return new Response('Run pulls.review -d to sign in', { status: 401 })
    return next()
  })
  app.get('/api/status', () => ({ pid: process.pid }))
  app.use('/api/**', bodyLimit(8192))
  app.post('/api/stop', () => {
    setTimeout(stop, 25)
    return { stopping: true }
  })
  app.get('/api/repos', () => registry.repos())
  // New commits in any registered worktree, for the shell's dots and notifications.
  app.get('/api/events', () => {
    const encoder = new TextEncoder()
    let close = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text))
          }
          catch {
            close()
          }
        }
        const unsubscribe = commits.subscribe(event => send(`data: ${JSON.stringify(event)}\n\n`))
        shells.add(send)
        const ping = setInterval(send, 30_000, ': ping\n\n')
        close = () => {
          unsubscribe()
          shells.delete(send)
          clearInterval(ping)
        }
        send(': connected\n\n')
      },
      cancel: () => close(),
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
  })
  app.get('/api/worktrees', async (event) => {
    const path = event.url.searchParams.get('path')
    if (!(await registry.repos()).some(repo => repo.path === path))
      return new Response('Not registered', { status: 404 })
    return worktrees(path!)
  })
  app.post('/api/repos', async (event) => {
    const parsed = v.safeParse(pathSchema, await readBody(event))
    if (!parsed.success)
      return new Response('A repository path is required', { status: 400 })
    try {
      const tree = await registry.add(parsed.output.path)
      void commits.rescan()
      return tree
    }
    catch {
      return new Response('Cannot register this git repository', { status: 400 })
    }
  })
  app.delete('/api/repos', async (event) => {
    const parsed = v.safeParse(pathSchema, await readBody(event))
    if (!parsed.success)
      return new Response('A repository path is required', { status: 400 })
    await registry.remove(parsed.output.path)
    void commits.rescan()
    for (const [socket, id] of connections) {
      if (!await registry.find(id))
        socket.destroy()
    }
    return { removed: true }
  })
  app.post('/api/launch', async (event) => {
    const parsed = v.safeParse(launchSchema, await readBody(event))
    if (!parsed.success)
      return new Response('A worktree path is required', { status: 400 })
    const tree = await registry.addCurrent(parsed.output.path)
    if (!tree)
      return new Response('Not a git repository', { status: 422 })
    void commits.rescan()
    const path = `/r/${tree.id}${parsed.output.page}`
    const token = launches.issue(path)
    if (parsed.output.show) {
      for (const send of shells)
        send(`event: show\ndata: ${JSON.stringify(path)}\n\n`)
    }
    return { url: `${origin}/login?token=${token}`, path, shown: parsed.output.show && shells.size > 0 }
  })
  // The tab shell (plans/fork/02); each tab is a review under `/r/<id>/`.
  app.get('/', () => shell.page())
  app.get('/sw.js', () => new Response(SERVICE_WORKER, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } }))
  app.get('/assets/**', event => shell.serve(event))
  app.get('/favicon.svg', event => shell.serve(event))
  app.all('/r/**', async (event) => {
    const id = routeId(event.url.pathname)
    const tree = id ? await registry.find(id) : undefined
    if (!tree)
      return new Response('Worktree not registered', { status: 404 })
    // Opened in the address bar (not a tab's frame): the shell, which shows this page in a tab.
    if (event.req.method === 'GET' && event.req.headers.get('sec-fetch-dest') === 'document')
      return shell.page()
    const target = await children.get(tree)
    const childOrigin = `http://127.0.0.1:${target.port}`
    try {
      return await proxyRequest(event, childOrigin + event.url.pathname + event.url.search, {
        headers: { cookie: '', authorization: '', host: new URL(childOrigin).host, origin: childOrigin },
      })
    }
    catch {
      throw new HTTPError('Worktree server unavailable', { status: 502 })
    }
  })
  return app
}
