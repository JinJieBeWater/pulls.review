import type { Repo, Worktree } from './schema'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import * as v from 'valibot'
import { RepoSchema } from './schema'

const exec = promisify(execFile)
const registrySchema = v.object({ repos: v.array(v.pipe(RepoSchema, v.check(repo => isAbsolute(repo.path)))) })

export function worktreeId(path: string): string {
  const name = basename(path).replace(/[^\w-]/g, '-').slice(0, 48) || 'repo'
  return `${name}-${createHash('sha256').update(path).digest('hex').slice(0, 10)}`
}

export async function atomicWrite(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  }
  finally {
    await rm(temporary, { force: true })
  }
}

async function readWorktrees(path: string) {
  const cwd = await realpath(path)
  const { stdout } = await exec('git', ['worktree', 'list', '--porcelain', '-z'], { cwd })
  let main: string | undefined
  const result: Worktree[] = []
  for (const record of stdout.split('\0\0').filter(Boolean)) {
    const fields = record.split('\0')
    const path = fields.find(field => field.startsWith('worktree '))?.slice(9)
    if (!path || fields.some(field => field.startsWith('prunable')))
      continue
    let canonical: string
    try {
      canonical = await realpath(path)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        continue
      throw error
    }
    main ??= canonical
    if (fields.includes('bare'))
      continue
    result.push({
      id: worktreeId(canonical),
      path: canonical,
      branch: fields.find(field => field.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, ''),
    })
  }
  return { main, trees: result }
}

export async function worktrees(path: string): Promise<Worktree[]> {
  return (await readWorktrees(path)).trees
}

export type RepoRegistry = ReturnType<typeof createRepoRegistry>

export function createRepoRegistry(file: string) {
  let pending: Promise<unknown> = Promise.resolve()
  let snapshot: { trees: Promise<Map<string, Worktree>>, expires: number } | undefined

  async function repos(): Promise<Repo[]> {
    try {
      return v.parse(registrySchema, JSON.parse(await readFile(file, 'utf8'))).repos
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return []
      throw error
    }
  }

  function update(change: (repos: Repo[]) => Repo[]) {
    const next = pending.then(async () => {
      await atomicWrite(file, { repos: change(await repos()) })
      snapshot = undefined
    })
    pending = next.catch(() => {})
    return next
  }

  async function add(path: string): Promise<Worktree> {
    const cwd = await realpath(path)
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd })
    const current = await realpath(stdout.replace(/\r?\n$/, ''))
    const { main, trees } = await readWorktrees(current)
    const tree = trees.find(tree => tree.path === current)
    if (!main || !tree)
      throw new Error('Not an available git worktree')
    await update(repos => repos.some(repo => repo.path === main) ? repos : [...repos, { path: main }])
    return tree
  }

  async function addCurrent(path: string): Promise<Worktree | undefined> {
    const cwd = await realpath(path)
    try {
      const { stdout } = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd, env: { ...process.env, LC_ALL: 'C' } })
      if (stdout.trim() !== 'true')
        return
    }
    catch (error) {
      const failure = error as { code?: number | string, stderr?: string }
      if (failure.code === 128 && failure.stderr?.includes('not a git repository'))
        return
      throw error
    }
    return add(cwd)
  }

  function remove(path: string): Promise<void> {
    return update(repos => repos.filter(repo => repo.path !== path))
  }

  async function scan(): Promise<Map<string, Worktree>> {
    const trees = new Map<string, Worktree>()
    for (const repo of await repos()) {
      try {
        for (const tree of await worktrees(repo.path))
          trees.set(tree.id, tree)
      }
      catch {
        // An unavailable registration must not prevent access to other repositories.
      }
    }
    return trees
  }

  async function find(id: string): Promise<Worktree | undefined> {
    // shortcut: external worktree changes can lag 1s; invalidate on Git events if immediate discovery is needed.
    if (!snapshot || snapshot.expires <= Date.now()) {
      const next = { trees: scan(), expires: Number.POSITIVE_INFINITY }
      snapshot = next
      void next.trees.then(
        () => { next.expires = Date.now() + 1000 },
        () => { next.expires = 0 },
      )
    }
    return (await snapshot.trees).get(id)
  }

  return { repos, add, addCurrent, remove, find }
}
