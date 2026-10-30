import { afterEach, expect, it, vi } from 'vitest'
import { daemonWorktreeId } from './daemon'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('recognizes only daemon mounts, not standalone or hub pages', () => {
  for (const [base, id] of [['/r/repo-123/', 'repo-123'], ['/', undefined], ['/__pulls.review/', undefined], ['/r/repo-123/compare/', undefined]]) {
    vi.stubGlobal('document', { baseURI: `http://127.0.0.1:7855${base}` })
    expect(daemonWorktreeId()).toBe(id)
  }
})
