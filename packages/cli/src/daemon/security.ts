import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export const COOKIE = 'pulls_session'
export const secret = () => randomBytes(32).toString('hex')

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function requestGuard(headers: Headers, method: string, origin: string, websocket = false): number | undefined {
  if (headers.get('host') !== new URL(origin).host)
    return 403
  const supplied = headers.get('origin')
  if (supplied !== null && supplied !== origin)
    return 403
  if ((websocket || !['GET', 'HEAD'].includes(method)) && supplied !== origin)
    return 403
}

export function hasSession(headers: Headers, session: string): boolean {
  return (headers.get('cookie') || '').split(';').some((part) => {
    const [name, ...value] = part.trim().split('=')
    return name === COOKIE && equal(value.join('='), session)
  })
}

export function createLaunchTokens() {
  const tokens = new Map<string, { path: string, expires: number }>()

  function issue(path: string, now = Date.now()): string {
    for (const [token, entry] of tokens) {
      if (entry.expires <= now)
        tokens.delete(token)
    }
    const token = secret()
    tokens.set(token, { path, expires: now + 60_000 })
    return token
  }

  function consume(token: string, now = Date.now()): string | undefined {
    const entry = tokens.get(token)
    tokens.delete(token)
    return entry && entry.expires > now ? entry.path : undefined
  }

  return { issue, consume }
}
