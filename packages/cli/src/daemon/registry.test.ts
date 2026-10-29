import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRepoRegistry, worktreeId, worktrees } from './registry'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, realpath: vi.fn(fs.realpath) }
})

const exec = promisify(execFile)
const temporary: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(name = 'main') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulls-registry-')))
  temporary.push(root)
  const main = join(root, name)
  const linked = join(root, 'linked')
  const git = (args: string[], cwd = root) => exec('git', args, { cwd, env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1' } })
  await git(['init', '-b', 'main', main])
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial'], main)
  await git(['worktree', 'add', '-b', 'feature', linked], main)
  const file = join(root, 'home', 'repos.json')
  return { root, main, linked, file, registry: createRepoRegistry(file), git }
}

describe('repository registry', () => {
  it('shares lookup scans until expiry and invalidates them after registration changes', async () => {
    const { root, main, linked, file, registry, git } = await fixture()
    await registry.add(main)
    await writeFile(file, JSON.stringify({ repos: [{ path: join(root, 'missing') }, { path: main }] }))
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    vi.mocked(realpath).mockClear()
    const id = worktreeId(linked)
    const lookups = await Promise.all(Array.from({ length: 4 }, () => registry.find(id)))
    expect(lookups).toEqual(Array.from({ length: 4 }, () => ({ id, path: linked, branch: 'feature' })))
    expect(await registry.find(id)).toEqual(lookups[0])
    expect(vi.mocked(realpath).mock.calls.filter(([path]) => path === linked)).toHaveLength(1)

    const added = join(root, 'added')
    await git(['worktree', 'add', '-b', 'added', added], main)
    clock.mockReturnValue(2001)
    expect(await registry.find(worktreeId(added))).toMatchObject({ path: added, branch: 'added' })
    expect(vi.mocked(realpath).mock.calls.filter(([path]) => path === linked)).toHaveLength(2)

    await git(['checkout', '--detach'], added)
    await registry.add(main)
    expect(await registry.find(worktreeId(added))).toMatchObject({ path: added, branch: undefined })
    await registry.remove(main)
    expect(await registry.find(id)).toBeUndefined()
  })

  it('registers only the canonical main checkout, including calls from a linked worktree or symlink', async () => {
    const { root, main, linked, file, registry } = await fixture()
    const alias = join(root, 'alias')
    await symlink(linked, alias)
    expect(await registry.repos()).toEqual([])
    const current = await registry.add(alias)
    expect(current).toMatchObject({ id: worktreeId(linked), path: linked, branch: 'feature' })
    await Promise.all([registry.add(main), registry.add(linked)])
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ repos: [{ path: main }] })
    expect(await worktrees(main)).toEqual([
      { id: worktreeId(main), path: main, branch: 'main' },
      { id: worktreeId(linked), path: linked, branch: 'feature' },
    ])
    expect(await registry.find(worktreeId(linked))).toEqual(current)
    await registry.remove(main)
    expect(await registry.find(current.id)).toBeUndefined()
    expect((await stat(linked)).isDirectory()).toBe(true)
  })

  it('reads branches live and does not accept arbitrary paths or malformed registry files', async () => {
    const { root, main, linked, file, registry, git } = await fixture()
    await expect(registry.add(root)).rejects.toThrow()
    await registry.add(main)
    await git(['checkout', '--detach'], linked)
    expect((await worktrees(main))[1].branch).toBeUndefined()
    await writeFile(file, '{broken')
    await expect(registry.add(main)).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('{broken')
    await writeFile(file, '{"repos":[{"path":"relative"}]}')
    await expect(registry.repos()).rejects.toThrow()
  })

  it('skips automatic registration outside git but still registers a linked current checkout', async () => {
    const { root, main, linked, registry } = await fixture()
    expect(await registry.addCurrent(root)).toBeUndefined()
    expect(await registry.repos()).toEqual([])
    await expect(registry.add(root)).rejects.toThrow()
    expect((await registry.addCurrent(linked))?.path).toBe(linked)
    expect(await registry.repos()).toEqual([{ path: main }])
  })

  it('derives URL-safe ids from the whole canonical path, not just its name', () => {
    expect(worktreeId('/one/a repo')).toMatch(/^a-repo-[a-f0-9]{10}$/)
    expect(worktreeId('/two/a repo')).not.toBe(worktreeId('/one/a repo'))
  })

  it('can discover linked worktrees through a bare main directory without treating it as a checkout', async () => {
    const { root, main, registry, git } = await fixture()
    const bare = join(root, 'bare.git')
    const linked = join(root, 'bare-linked')
    await git(['clone', '--bare', main, bare])
    await git(['worktree', 'add', '-b', 'bare-linked', linked], bare)
    const tree = await registry.add(linked)
    expect(await registry.repos()).toEqual([{ path: bare }])
    expect(await worktrees(bare)).toEqual([{ id: worktreeId(linked), path: linked, branch: 'bare-linked' }])
    expect(await registry.find(tree.id)).toEqual(tree)
  })
})
