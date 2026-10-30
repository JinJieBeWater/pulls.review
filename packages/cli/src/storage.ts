import type { Driver } from 'unstorage'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
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
