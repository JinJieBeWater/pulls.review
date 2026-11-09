import type { DiffsPayload } from '@pulls.review/core/types'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCacheRepositories } from '@pulls.review/core/cache'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import memoryDriver from 'unstorage/drivers/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dirLock, flatKeys } from './storage'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pulls-review-cache-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('flatKeys', () => {
  it('stores keys that would need one path as both a file and a directory', async () => {
    const storage = createStorage({ driver: flatKeys(fsDriver({ base: dir })) })
    await storage.setItem('pr-meta:github:o/r@main...feat', 'a')
    await storage.setItem('pr-meta:github:o/r@main...feat/x', 'b')
    await storage.setItem('review:sha', 'c')

    expect(await storage.getItem('pr-meta:github:o/r@main...feat')).toBe('a')
    expect(await storage.getItem('pr-meta:github:o/r@main...feat/x')).toBe('b')
    expect((await storage.getKeys('pr-meta:')).sort()).toEqual(['pr-meta:github:o:r@main...feat', 'pr-meta:github:o:r@main...feat:x'])
    await storage.removeItem('review:sha')
    expect(await storage.getKeys('review:')).toEqual([])
  })

  it('stores keys longer than a file name allows', async () => {
    const storage = createStorage({ driver: flatKeys(fsDriver({ base: dir })) })
    const scope = `local:${encodeURIComponent(`/Users/me/${'deep/'.repeat(20)}worktree`)}@origin%2Fdev...feature`
    const a = `file-content:${scope}:e40bcd29:docs/${'part/'.repeat(10)}a.md`
    const b = `file-content:${scope}:e40bcd29:docs/${'part/'.repeat(10)}b.md`
    await storage.setItem(a, 'a')
    await storage.setItem(b, 'b')

    expect(await storage.getItem(a)).toBe('a')
    expect(await storage.getItem(b)).toBe('b')
    // A listed key isn't the original text, but still addresses its entry.
    const listed = await storage.getKeys('file-content:')
    expect(listed).toHaveLength(2)
    expect((await storage.getItems(listed)).map(({ value }) => value).sort()).toEqual(['a', 'b'])
    await Promise.all(listed.map(key => storage.removeItem(key)))
    expect(await storage.getKeys('file-content:')).toEqual([])
  })
})

describe('dirLock', () => {
  const diff = (sha: string): DiffsPayload => ({ ref: { kind: 'local', repo: '/r', target: '' }, title: 't', files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0, isBinary: false, sha, hunks: [] }] })

  it('keeps an analysis and session a worktree server saves while the daemon stores a refetched diff', async () => {
    // Two processes' caches: their own storage and lock over one store, as the daemon and a worktree server share the cache dir.
    const shared = memoryDriver()
    const daemonStorage = createStorage({ driver: shared })
    const daemon = createCacheRepositories(daemonStorage, undefined, dirLock(dir)).diffs
    const child = createCacheRepositories(createStorage({ driver: shared }), undefined, dirLock(dir)).diffs
    await daemon.putDiff('k', diff('old'), 'old')

    // The daemon's refetch stops right after reading the entry it merges into, as a slow read leaves it.
    let resume!: () => void
    const paused = new Promise<void>(resolve => resume = resolve)
    let reading!: () => void
    const read = new Promise<void>(resolve => reading = resolve)
    const getItem = daemonStorage.getItem.bind(daemonStorage)
    daemonStorage.getItem = (async (key: string) => {
      const value = await getItem(key)
      if (key.startsWith('pr-body:')) {
        reading()
        await paused
      }
      return value
    }) as typeof daemonStorage.getItem
    const refetch = daemon.putDiff('k', diff('new'), 'new')
    await read
    const llm = { source: 'llm' as const, groups: [], schemaVersion: 1, generatedAt: 'now', headSha: 'old' }
    const saved = Promise.all([child.setAnalyzedResult('k', 'llm', llm), child.setLlmSession('k', { messages: [], chatStartIndex: 0 })])
    await new Promise(resolve => setTimeout(resolve, 50))
    resume()
    await Promise.all([refetch, saved])

    const entry = await child.get('k')
    expect([entry?.headSha, entry?.analyzedBy.llm, entry?.llmSession]).toEqual(['new', llm, { messages: [], chatStartIndex: 0 }])
  })

  it('takes over a lock its holder left behind', async () => {
    const lock = dirLock(dir)
    const left = join(dir, createHash('sha256').update('k').digest('hex'))
    mkdirSync(left)
    utimesSync(left, new Date(0), new Date(0))
    expect(await lock('k', async () => 'ran')).toBe('ran')
  })
})
