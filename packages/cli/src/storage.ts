import type { CacheRepositories, KeyLock } from '@pulls.review/core/cache'
import type { Driver } from 'unstorage'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { createCacheRepositories } from '@pulls.review/core/cache'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'

/**
 * The fs driver maps every `:` of a key to a directory, so `a:b` (a file) and `a:b:c`
 * (needing `a/b/` as a directory) can't both exist. Keys stay one directory per
 * collection prefix (`pr-meta:`, `review:`, ...) with the rest escaped into one file name.
 * A name past the 255-byte file-name limit (a deep worktree path in the key) keeps a
 * readable prefix and ends in the key's hash. `getKeys` lists such a key by its file
 * name: it still reads and removes the entry, but its text is not the original key.
 */
export function flatKeys(driver: Driver): Driver {
  const encode = (key: string) => {
    const [head = '', ...rest] = key.split(':')
    if (!rest.length)
      return head
    const name = encodeURIComponent(rest.join(':'))
    return `${head}:${name.length <= 255 ? name : `${name.slice(0, 190).replace(/%[0-9A-F]?$/, '')}~${createHash('sha256').update(name).digest('hex')}`}`
  }
  // The fs driver lists keys as paths (`pr-meta/<file>`).
  const decode = (key: string) => {
    const [head = '', ...rest] = key.split(/[:/]/)
    return rest.length ? `${head}:${decodeURIComponent(rest.join(':'))}` : head
  }
  return {
    ...driver,
    hasItem: (key, opts) => driver.hasItem(encode(key), opts),
    getItem: (key, opts) => driver.getItem(encode(key), opts),
    setItem: (key, value, opts) => driver.setItem?.(encode(key), value, opts),
    removeItem: (key, opts) => driver.removeItem?.(encode(key), opts),
    getKeys: async (base, opts) => (await driver.getKeys(encode(base.replace(/:$/, '')), opts)).map(decode),
  }
}

/** `<git-common-dir>/pulls-review`: shared by every worktree of the repo, never committed. */
export async function repoCacheDir(cwd: string): Promise<string> {
  const { stdout } = await promisify(execFile)('git', ['rev-parse', '--git-common-dir'], { cwd })
  return resolve(cwd, stdout.trim(), 'pulls-review')
}

export async function createRepoCacheDriver(cwd: string): Promise<Driver> {
  return flatKeys(fsDriver({ base: await repoCacheDir(cwd) }))
}

/** Past this, a lock is a crashed holder's: a cache write takes well under a second. */
const STALE_LOCK_MS = 30_000

/**
 * `task` run holding `<dir>/<hash of key>`: `mkdir` creates a directory or fails at once, in every process, so
 * processes sharing a cache (the daemon, each worktree server) take turns at an entry's read-merge-write.
 */
export function dirLock(dir: string): KeyLock {
  return async (key, task) => {
    const path = join(dir, createHash('sha256').update(key).digest('hex'))
    await mkdir(dir, { recursive: true })
    for (let wait = 2; ; wait = Math.min(wait * 2, 50)) {
      try {
        await mkdir(path)
        break
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw error
        // shortcut: two waiters can both find one lock stale and both take it; give the holder a heartbeat if that ever bites.
        const held = await stat(path).then(stats => Date.now() - stats.mtimeMs, () => 0)
        if (held > STALE_LOCK_MS)
          await rm(path, { recursive: true, force: true })
        else
          await delay(wait)
      }
    }
    try {
      return await task()
    }
    finally {
      await rm(path, { recursive: true, force: true })
    }
  }
}

/** The repo's cache, its entries' writes locked across the processes that share it (`dirLock`). */
export async function createRepoCaches(cwd: string): Promise<CacheRepositories> {
  const dir = await repoCacheDir(cwd)
  return createCacheRepositories(createStorage({ driver: flatKeys(fsDriver({ base: dir })) }), undefined, dirLock(join(dir, 'locks')))
}
