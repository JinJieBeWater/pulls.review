import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flatKeys } from './storage'

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
