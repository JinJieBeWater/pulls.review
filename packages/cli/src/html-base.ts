import { onResponse } from 'h3'

/** Set the base before the browser's preload scanner sees any relative assets. */
export function staticBase(basePath: string) {
  return onResponse(async (response, event) => {
    if (event.req.method !== 'GET' || !new URL(event.req.url).pathname.startsWith(basePath) || response.status !== 200 || !response.headers.get('content-type')?.startsWith('text/html'))
      return
    const html = (await response.text()).replace('<head>', `<head>\n    <base href="${basePath}">`)
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return new Response(html, { status: response.status, headers })
  })
}
