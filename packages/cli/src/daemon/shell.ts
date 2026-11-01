import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { serveStatic } from 'h3'
import { PWA_PROTOCOL } from './schema'

/** What makes the tab shell (`/`) installable as an app; public, like any site's. */
export const MANIFEST = JSON.stringify({
  name: 'pulls.review',
  short_name: 'pulls.review',
  description: 'Review local changes, grouped and summarized.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  launch_handler: { client_mode: 'focus-existing' },
  protocol_handlers: [{ protocol: PWA_PROTOCOL, url: '/login?token=%s' }],
  background_color: '#ffffff',
  theme_color: '#ffffff',
  icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
})

/**
 * Network first for the shell's own files, so it is never stale while the daemon runs,
 * and their last copy when it is down, so the shell can say so. Reviews (`/r/`), the API
 * and sign-in always go to the network.
 */
/** shortcut: old hashed assets stay cached after a rebuild; clear by version if it grows. */
export const SERVICE_WORKER = `const CACHE = 'pulls-review-shell'
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== location.origin || /^\\/(?:r|api)\\/|^\\/login$/.test(url.pathname))
    return
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone()
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)))
    }
    return response
  }, async () => await caches.match(event.request, { ignoreSearch: true }) ?? Response.error()))
})
`

/** The shell page and the client's root files (`/assets/…`, `/favicon.svg`), from the built client. */
export function createShellFiles(client: string) {
  const file = (id: string) => {
    const path = resolve(client, `.${decodeURIComponent(id)}`)
    return path.startsWith(client + sep) ? path : undefined
  }
  return {
    page: async () => new Response(await readFile(join(client, 'shell.html'), 'utf8'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    serve: (event: Parameters<typeof serveStatic>[0]) => serveStatic(event, {
      getMeta: async (id) => {
        const path = file(id)
        const info = path ? await stat(path).catch(() => undefined) : undefined
        return info?.isFile() ? { size: info.size, mtime: info.mtime } : undefined
      },
      getContents: id => readFile(file(id)!),
    }),
  }
}
