import type { RepoRegistry } from './registry'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { watch } from 'chokidar'
import { worktrees } from './registry'

const exec = promisify(execFile)

export interface CommitEvent {
  /** The worktree's daemon id, as in `/r/<id>/`. */
  id: string
  repo: string
  branch?: string
  sha: string
  subject: string
}

const COMMIT = /^commit(?: \((?:amend|initial|merge)\))?: (.*)$/

/** Commits among appended reflog lines (`<old> <new> <who> <when>\t<message>`); checkouts, resets, rebases, merges and pulls are not. */
export function commitsIn(lines: string): { sha: string, subject: string }[] {
  return lines.split('\n').flatMap((line) => {
    const tab = line.indexOf('\t')
    const subject = tab === -1 ? undefined : line.slice(tab + 1).match(COMMIT)?.[1]
    return subject === undefined ? [] : [{ sha: line.split(' ')[1]!, subject }]
  })
}

const sizeOf = (path: string) => stat(path).then(info => info.size, () => 0)

/**
 * Watches the reflog (`<git-dir>/logs/HEAD`) of every registered worktree for new
 * commits, and each repository's `<git-common-dir>/worktrees/` for worktrees coming
 * and going (plans/fork/02).
 */
export function watchCommits(registry: Pick<RepoRegistry, 'repos'>) {
  const listeners = new Set<(event: CommitEvent) => void>()
  /** Each watched reflog's worktree, and how far it was read. */
  let reflogs = new Map<string, { id: string, repo: string, path: string, size: number }>()
  let worktreeDirs = new Set<string>()
  const watcher = watch([], { ignoreInitial: true, depth: 0 })
  // One step at a time: a rescan and a read share `reflogs`.
  let queue = Promise.resolve()
  const serial = (step: () => Promise<void>) => queue = queue.then(step).catch(() => {})

  async function scan() {
    const next = new Map<string, { id: string, repo: string, path: string, size: number }>()
    const dirs = new Set<string>()
    for (const repo of await registry.repos()) {
      try {
        for (const tree of await worktrees(repo.path)) {
          const { stdout } = await exec('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd: tree.path })
          const [gitDir, commonDir] = stdout.trim().split('\n') as [string, string]
          const reflog = join(gitDir, 'logs', 'HEAD')
          next.set(reflog, { id: tree.id, repo: repo.path, path: tree.path, size: reflogs.get(reflog)?.size ?? await sizeOf(reflog) })
          dirs.add(join(commonDir, 'worktrees'))
        }
      }
      catch {
        // An unavailable registration must not stop the others.
      }
    }
    const gone = [...reflogs.keys(), ...worktreeDirs].filter(path => !next.has(path) && !dirs.has(path))
    if (gone.length)
      watcher.unwatch(gone)
    const added = [...next.keys(), ...dirs].filter(path => !reflogs.has(path) && !worktreeDirs.has(path))
    reflogs = next
    worktreeDirs = dirs
    if (added.length)
      watcher.add(added)
  }

  async function read(reflog: string) {
    const entry = reflogs.get(reflog)
    if (!entry)
      return
    const size = await sizeOf(reflog)
    const from = entry.size
    entry.size = size
    // Shrunk: expired or rewritten, nothing new to tell.
    if (size <= from)
      return
    const handle = await open(reflog)
    const appended = Buffer.alloc(size - from)
    try {
      await handle.read(appended, 0, appended.length, from)
    }
    finally {
      await handle.close()
    }
    const commits = commitsIn(appended.toString('utf8'))
    if (!commits.length)
      return
    const branch = await exec('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: entry.path }).then(({ stdout }) => stdout.trim() || undefined, () => undefined)
    for (const commit of commits) {
      for (const listener of listeners)
        listener({ id: entry.id, repo: entry.repo, branch, ...commit })
    }
  }

  let rescanTimer: ReturnType<typeof setTimeout> | undefined
  function onChange(path: string) {
    if (reflogs.has(path)) {
      void serial(() => read(path))
      return
    }
    // A worktree came or went; git is still writing it, so let it settle.
    clearTimeout(rescanTimer)
    rescanTimer = setTimeout(() => void serial(scan), 300)
  }
  watcher.on('add', onChange)
  watcher.on('change', onChange)
  watcher.on('addDir', onChange)
  watcher.on('unlinkDir', onChange)
  watcher.on('error', () => {})

  return {
    rescan: () => serial(scan),
    subscribe(listener: (event: CommitEvent) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    async close() {
      clearTimeout(rescanTimer)
      await watcher.close()
    },
  }
}

export type CommitWatcher = ReturnType<typeof watchCommits>
