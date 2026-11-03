import type { Duplex } from 'node:stream'
import type { WorktreeServers } from './children'
import type { CommitWatcher } from './commits'
import type { AccessLog } from './proxy'
import type { RepoRegistry } from './registry'
import type { Worktree } from './schema'
import type { SettingsStore } from './settings'
import process from 'node:process'
import { bodyLimit, H3, HTTPError, proxyRequest, readBody } from 'h3'
import * as v from 'valibot'
import { routeId } from './proxy'
import { worktrees } from './registry'
import { COMMAND, PWA_PROTOCOL } from './schema'
import { COOKIE, createLaunchTokens, hasSession, requestGuard } from './security'
import { agentChoice, SharedSettingsSchema } from './settings'
import { createShellFiles, MANIFEST, SERVICE_WORKER } from './shell'

const pathSchema = v.object({ path: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)) })
// The page inside the worktree's review, as `pageFor` picks it.
const launchSchema = v.object({ ...pathSchema.entries, page: v.optional(v.pipe(v.string(), v.startsWith('/'), v.maxLength(4096)), '/') })

export function createDaemonApp(options: {
  origin: string
  session: string
  /** The built client: the shell page and its assets. */
  client: string
  registry: Pick<RepoRegistry, 'repos' | 'add' | 'addCurrent' | 'remove' | 'find'>
  children: Pick<WorktreeServers, 'get'>
  commits: Pick<CommitWatcher, 'rescan' | 'subscribe'>
  settings: SettingsStore
  connections: Map<Duplex, string>
  stop: () => void
  log: AccessLog
}): H3 {
  const { origin, session, registry, children, commits, settings, connections, stop, log } = options
  const launches = createLaunchTokens()
  const shell = createShellFiles(options.client)

  /** `--analyze` with a local agent picked: the worktree server starts the run, so it needs no page to. */
  async function analyze(tree: Worktree, page: string) {
    const choice = agentChoice(await settings.read())
    if (choice)
      (await children.get(tree)).send({ type: 'analyze', page: page.split('?')[0]!, ...choice })
  }
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
      const credential = event.url.searchParams.get('token') || ''
      const token = credential.startsWith(`${PWA_PROTOCOL}:`) ? credential.slice(PWA_PROTOCOL.length + 1) : credential
      const path = launches.consume(token)
      if (!path)
        return new Response('Invalid or expired launch token', { status: 401 })
      // A running PWA exchanges the token without reloading its shell or drafts.
      const headers = { 'Set-Cookie': `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` }
      if (event.req.headers.get('accept') === 'application/json')
        return Response.json({ path }, { headers })
      return new Response(null, {
        status: 303,
        // A year: the session secret survives restarts (`loadSession`), so an installed app stays signed in.
        headers: { ...headers, Location: path },
      })
    }
    // Fetched without the cookie by the browser's install check.
    if (event.url.pathname === '/manifest.webmanifest' && event.req.method === 'GET')
      return new Response(MANIFEST, { headers: { 'Content-Type': 'application/manifest+json' } })
    if (!hasSession(event.req.headers, session))
      return new Response(`Run ${COMMAND} -d to sign in`, { status: 401 })
    return next()
  })
  app.get('/api/status', () => ({ pid: process.pid }))
  app.use('/api/**', bodyLimit(8192))
  app.post('/api/stop', () => {
    setTimeout(stop, 25)
    return { stopping: true }
  })
  app.get('/api/repos', () => registry.repos())
  app.get('/api/settings', () => settings.read())
  app.put('/api/settings', async (event) => {
    const parsed = v.safeParse(SharedSettingsSchema, await readBody(event))
    if (!parsed.success)
      return new Response('Invalid settings', { status: 400 })
    await settings.write(parsed.output)
    return parsed.output
  })
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
        const ping = setInterval(send, 30_000, ': ping\n\n')
        close = () => {
          unsubscribe()
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
    if (new URL(path, origin).searchParams.has('analyze'))
      void analyze(tree, parsed.output.page).catch(error => process.stderr.write(`Could not start the analysis: ${error instanceof Error ? error.message : error}\n`))
    const token = launches.issue(path)
    return { url: `${origin}/login?token=${token}`, path }
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
