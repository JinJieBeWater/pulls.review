import type { Storage } from 'unstorage'

const FILE_CONTENT_KEY_PREFIX = 'file-content:'

export interface FileContentCache {
  get: (sha: string, path: string) => Promise<string | undefined>
  set: (sha: string, path: string, content: string) => Promise<void>
}

/**
 * Keyed by (ref sha, path) - `sha` here is the diff's base/head **commit** sha
 * (already on `DiffsPayload.base`/`head`, no extra request needed to look up a
 * per-blob sha), which is just as content-addressed as a blob sha for caching
 * purposes: the same commit + path always yields the same bytes. A local working
 * tree's `worktree:<hash>` hashes its full-index diff, so it names the content too.
 * No diff in the key: every diff, branch or worktree reaching a commit shares its files.
 */
function fileContentKey(sha: string, path: string): string {
  return `${FILE_CONTENT_KEY_PREFIX}${sha}:${path}`
}

export function createFileContentCache(storage: Storage): FileContentCache {
  return {
    async get(sha, path) {
      const value = await storage.getItem(fileContentKey(sha, path))
      // A corrupt/previous-shape entry is treated as a cache miss rather than throwing.
      return typeof value === 'string' ? value : undefined
    },
    async set(sha, path, content) {
      await storage.setItem(fileContentKey(sha, path), content)
    },
  }
}
