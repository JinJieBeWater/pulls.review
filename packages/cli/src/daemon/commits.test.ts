import type { CommitEvent } from './commits'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { commitsIn, watchCommits } from './commits'
import { worktreeId } from './registry'

const exec = promisify(execFile)
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()))
})

it('reads only commits from appended reflog lines', () => {
  const line = (message: string) => `${'a'.repeat(40)} ${'b'.repeat(40)} A <a@a> 1 +0000\t${message}`
  expect(commitsIn([
    line('commit: Fix the parser'),
    line('commit (amend): Fix the parser, again'),
    line('commit (initial): Start'),
    line('checkout: moving from main to feature'),
    line('rebase (finish): returning to refs/heads/feature'),
    line('pull: Fast-forward'),
    line('cherry-pick: Port it'),
    line('reset: moving to HEAD~1'),
    '',
  ].join('\n')).map(commit => commit.subject)).toEqual(['Fix the parser', 'Fix the parser, again', 'Start'])
})

it('tells about commits in every registered worktree, including ones added later', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulls-commits-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const main = join(root, 'main')
  const git = (cwd: string, ...args: string[]) => exec('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd })
  await exec('git', ['init', '-q', '-b', 'main', main])
  await git(main, 'commit', '-q', '--allow-empty', '-m', 'before watching')

  const watcher = watchCommits({ repos: async () => [{ path: main }] })
  cleanup.push(() => watcher.close())
  const events: CommitEvent[] = []
  watcher.subscribe(event => events.push(event))
  await watcher.rescan()

  await writeFile(join(main, 'a.txt'), 'a')
  await git(main, 'add', '.')
  await git(main, 'commit', '-q', '-m', 'Add a')
  await vi.waitFor(() => expect(events.map(event => event.subject)).toEqual(['Add a']), { timeout: 5000 })
  expect(events[0]).toMatchObject({ id: worktreeId(main), repo: main, branch: 'main' })

  const linked = join(root, 'linked')
  await git(main, 'worktree', 'add', '-q', '-b', 'feature', linked)
  // The new worktree is picked up from `.git/worktrees/` after it settles.
  await new Promise(resolve => setTimeout(resolve, 1000))
  await git(linked, 'commit', '-q', '--allow-empty', '-m', 'From the linked worktree')
  const linkedId = worktreeId(await realpath(linked))
  await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ id: linkedId, subject: 'From the linked worktree', branch: 'feature' }), { timeout: 5000 })
  expect(events).toHaveLength(2)
}, 20_000)
