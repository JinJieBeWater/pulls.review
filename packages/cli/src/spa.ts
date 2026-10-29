import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { H3 } from 'h3'
import { staticBase } from './html-base'

/**
 * devframe's SPA fallback skips any path that looks like a file, and refs do: `main...feat`
 * ends in `.feat`, `v1.2` in `.2`. Pages whose path carries a ref (local ones, and GitHub
 * compares under `/gh/`) get the SPA's `index.html` here, before devframe's static handler sees them.
 */
export function createAppWithRefRoutes(basePath = '/'): H3 {
  const app = new H3()
  app.use(staticBase(basePath))
  const index = fileURLToPath(new URL('./client/index.html', import.meta.url))
  app.use(async (event, next) => {
    if (!event.url.pathname.startsWith(basePath) || !/^(?:compare|branch|commit|gh)\//.test(event.url.pathname.slice(basePath.length)) || !event.req.headers.get('accept')?.includes('text/html'))
      return next()
    return new Response(await readFile(index, 'utf8'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  })
  return app
}
