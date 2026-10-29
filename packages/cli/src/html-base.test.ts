import { H3 } from 'h3'
import { describe, expect, it } from 'vitest'
import { staticBase } from './html-base'

const index = '<html><head><script src="./assets/app.js"></script></head><body></body></html>'

function serve(basePath: string, contentType: string) {
  return new H3().use(staticBase(basePath)).use(() => new Response(index, {
    headers: { 'content-type': contentType, 'content-length': String(index.length) },
  }))
}

describe('staticBase', () => {
  it.each(['/', '/r/a/'])('sets the base on deep links under %s', async (basePath) => {
    const response = await serve(basePath, 'text/html').fetch(new Request(`http://localhost${basePath}compare/main...v1.2`))
    expect(await response.text()).toContain(`<head>\n    <base href="${basePath}"><script`)
    expect(response.headers.has('content-length')).toBe(false)
  })

  it('leaves other responses unchanged', async () => {
    expect(await (await serve('/r/a/', 'text/javascript').fetch(new Request('http://localhost/r/a/assets/app.js'))).text()).toBe(index)
    expect(await (await serve('/r/a/', 'text/html').fetch(new Request('http://localhost/r/ab/'))).text()).toBe(index)
  })
})
