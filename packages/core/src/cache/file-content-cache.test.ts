import { createStorage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { beforeEach, describe, expect, it } from 'vitest'
import { createFileContentCache } from './file-content-cache'

let cache: ReturnType<typeof createFileContentCache>

beforeEach(() => {
  cache = createFileContentCache(createStorage({ driver: memoryDriver() }))
})

describe('file content cache', () => {
  it('round-trips content for a given sha + path', async () => {
    await cache.set('sha-a', 'src/foo.ts', 'export const x = 1')
    await expect(cache.get('sha-a', 'src/foo.ts')).resolves.toBe('export const x = 1')
  })

  it('misses on an unknown entry', async () => {
    await expect(cache.get('sha-a', 'src/foo.ts')).resolves.toBeUndefined()
  })

  it('keys by sha and path', async () => {
    await cache.set('sha-a', 'src/foo.ts', 'old content')
    await cache.set('sha-b', 'src/foo.ts', 'new content')
    await cache.set('sha-a', 'src/bar.ts', 'bar content')

    await expect(cache.get('sha-a', 'src/foo.ts')).resolves.toBe('old content')
    await expect(cache.get('sha-b', 'src/foo.ts')).resolves.toBe('new content')
    await expect(cache.get('sha-a', 'src/bar.ts')).resolves.toBe('bar content')
  })
})
