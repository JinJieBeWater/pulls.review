import { describe, expect, it } from 'vitest'
import { COOKIE, createLaunchTokens, hasSession, secret } from './security'

const headers = (extra: Record<string, string> = {}) => new Headers({ host: '127.0.0.1:7855', ...extra })

describe('daemon authentication', () => {
  it('accepts only the complete session cookie, not substrings or malformed values', () => {
    const session = secret()
    expect(hasSession(headers(), session)).toBe(false)
    expect(hasSession(headers({ cookie: `other=x; ${COOKIE}=${session}; tail=y` }), session)).toBe(true)
    for (const cookie of [`x${COOKIE}=${session}`, `${COOKIE}=${session}x`, `${COOKIE}=é`, COOKIE])
      expect(hasSession(headers({ cookie }), session)).toBe(false)
  })

  it('exchanges each launch token once, before it expires', () => {
    const tokens = createLaunchTokens()
    const first = tokens.issue('/r/a/', 1_000)
    const second = tokens.issue('/r/b/', 1_001)
    expect(tokens.consume(first, 1_002)).toBe('/r/a/')
    expect(tokens.consume(first, 1_003)).toBeUndefined()
    expect(tokens.consume(second, 61_001)).toBeUndefined()
  })
})
