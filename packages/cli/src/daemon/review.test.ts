import type { DiffGroup, FileChange } from '@pulls.review/core/types'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { createCacheRepositories } from '@pulls.review/core/cache'
import { createLocalSource } from '@pulls.review/core/local'
import { createStorage } from 'unstorage'
import { afterEach, expect, it } from 'vitest'
import { fullRows, hunkRows, readFullFile, readReview, resolveGroups, setReviewed } from './review'

const exec = promisify(execFile)
const colors = { foreground: '#cccccc', keyword: '#ff00ff', string: '#00ff00', comment: '#808080' }
let root: string | undefined
afterEach(async () => {
  if (root)
    await rm(root, { recursive: true, force: true })
})

async function repo() {
  root = await mkdtemp(join(tmpdir(), 'pulls-review-pane-'))
  const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: string[]) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, env })
  await git('init', '-b', 'main')
  await writeFile(join(root, 'a.ts'), 'const a = 1\n/* one\n   two */\nexport { a }\n')
  await writeFile(join(root, 'a.test.ts'), 'it("a", () => {})\n')
  await git('add', '.')
  await git('commit', '-m', 'initial')
  return { root, git }
}

it('highlights each side of a hunk as one text, numbering old and new lines', () => {
  const rows = hunkRows({ header: '@@ -1,3 +1,3 @@', oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, patch: '@@ -1,3 +1,3 @@\n-const a = 1\n+let a = "x"\n /* one\n    two */' }, 'a.ts', colors)
  expect(rows.map(({ kind, old, new: next }) => [kind, old, next])).toEqual([['-', 1, undefined], ['+', undefined, 1], [' ', 2, 2], [' ', 3, 3]])
  expect(rows[0]!.tokens[0]).toEqual(['const ', '#ff00ff'])
  expect(rows[1]!.tokens).toContainEqual(['"x"', '#00ff00'])
  // The comment's second line is still a comment: the side was read as one text.
  expect(rows[3]!.tokens).toEqual([['   two */', '#808080']])
})

it('lays a file\'s whole new side around its hunks', () => {
  const file = { path: 'a.txt', hunks: [
    { header: '', oldStart: 2, oldLines: 1, newStart: 2, newLines: 2, patch: '-b\n+B\n+B2' },
    { header: '', oldStart: 4, oldLines: 1, newStart: 4, newLines: 0, patch: '-d' },
  ] }
  const rows = fullRows(file, 'a\nB\nB2\nc\ne\n', {})
  expect(rows.map(({ kind, old, new: next, tokens }) => `${kind}${old ?? ''}:${next ?? ''}:${tokens.map(([text]) => text).join('')}`)).toEqual([
    ' 1:1:a',
    '-2::b',
    '+:2:B',
    '+:3:B2',
    ' 3:4:c',
    '-4::d',
    ' 5:5:e',
  ])
})

it('resolves groups as the app does: renamed paths, missing paths, anchored notes and the rest uncategorized', () => {
  const file = (path: string, extra: Partial<FileChange> = {}): FileChange => ({ path, sha: path, status: 'modified', additions: 1, deletions: 0, isBinary: false, hunks: [{ header: '', oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, patch: '' }], ...extra })
  const groups: DiffGroup[] = [{
    key: 'g',
    label: 'G',
    category: 'core',
    filePaths: ['old.ts', 'gone.ts'],
    lineNotes: [{ path: 'old.ts', side: 'additions', line: 2, text: 'shown' }, { path: 'old.ts', side: 'additions', line: 9, text: 'not shown', critical: true }],
    children: [{ key: 'c', label: 'C', category: 'tests', filePaths: ['b.ts'] }],
  }]
  const [group, rest] = resolveGroups(groups, [file('new.ts', { previousPath: 'old.ts', status: 'renamed' }), file('b.ts'), file('c.ts')])
  expect(group).toMatchObject({ files: ['new.ts'], missing: ['gone.ts'], critical: true, children: [{ files: ['b.ts'] }] })
  expect(group!.notes['new.ts']).toEqual([{ text: 'shown', critical: false, anchor: { side: 'additions', line: 2 } }, { text: 'not shown', critical: true }])
  expect(rest).toMatchObject({ key: 'uncategorized', files: ['c.ts'] })
})

it('reads a page as the pane draws it, keeps reviewed marks, and flags a reviewed file that changed since', async () => {
  const { root } = await repo()
  const cache = createCacheRepositories(createStorage())
  const read = (running = {}) => readReview({ cwd: root, page: '/worktree', colors, cache, running: async () => running, agent: true })
  await writeFile(join(root, 'a.ts'), 'const a = 22\n/* one\n   two */\nexport { a }\n')
  await writeFile(join(root, 'a.test.ts'), 'it("b", () => {})\n')

  const first = await read()
  expect(first.source).toBe('rule-based')
  expect(first.groups.map(group => [group.label, group.files])).toEqual([['Code', ['a.ts']], ['Tests', ['a.test.ts']]])
  expect(first.files.find(file => file.path === 'a.test.ts')).toMatchObject({ test: true, noisy: false, reviewed: false, changed: false })
  expect(first.analysis).toEqual({ state: 'none', agent: true })
  // Rows only for the files asked for: a large diff's rows run to megabytes.
  const some = await readReview({ cwd: root, page: '/worktree', colors, cache, running: async () => ({}), agent: true, rows: ['a.ts'] })
  expect(some.files.map(file => [file.path, !!file.hunks])).toEqual([['a.test.ts', false], ['a.ts', true]])

  const a = first.files.find(file => file.path === 'a.ts')!
  await setReviewed({ cwd: root, page: '/worktree', cache, shas: [a.sha], reviewed: true })
  expect((await read()).files.find(file => file.path === 'a.ts')).toMatchObject({ reviewed: true, changed: false })

  await writeFile(join(root, 'a.ts'), 'const a = 333\n/* one\n   two */\nexport { a }\n')
  const changed = await read({ streamId: 's', progress: { step: 1, kind: 'thinking' } })
  expect(changed.files.find(file => file.path === 'a.ts')).toMatchObject({ reviewed: false, changed: true })
  expect(changed.analysis).toMatchObject({ state: 'running', progress: { kind: 'thinking' } })

  // Marking it again is the verdict on its current content.
  await setReviewed({ cwd: root, page: '/worktree', cache, shas: [changed.files.find(file => file.path === 'a.ts')!.sha], reviewed: true })
  expect((await read()).files.find(file => file.path === 'a.ts')).toMatchObject({ reviewed: true, changed: false })
})

it('shows the saved analysis, outdated once the diff moves on', async () => {
  const { root } = await repo()
  const cache = createCacheRepositories(createStorage())
  const read = () => readReview({ cwd: root, page: '/worktree', colors, cache, running: async () => ({}), agent: false })
  await writeFile(join(root, 'a.ts'), 'const a = 2\n')
  const { key, head } = await read()
  await cache.diffs.setAnalyzedResult(key, 'llm', { source: 'llm', groups: [{ key: 'x', label: 'The change', summary: '**Why**', category: 'core', filePaths: ['a.ts'] }], schemaVersion: 1, generatedAt: 'now', headSha: head!.sha, model: 'pi/m' })

  const current = await read()
  expect(current.source).toBe('llm')
  expect(current.groups.map(group => group.label)).toEqual(['The change'])
  expect(current.analysis).toMatchObject({ state: 'current', model: 'pi/m' })

  await writeFile(join(root, 'a.ts'), 'const a = 33\n')
  expect((await read()).analysis.state).toBe('outdated')
})

it('reads a file\'s whole new side for a commit page', async () => {
  const { root, git } = await repo()
  await writeFile(join(root, 'a.ts'), 'const a = 1\n/* one\n   two */\nexport { a, b }\n')
  await git('commit', '-am', 'export b')
  const sha = (await git('rev-parse', 'HEAD')).stdout.trim()
  const rows = await readFullFile({ cwd: root, page: `/commit/${sha}`, path: 'a.ts', colors })
  expect(rows.map(row => row.kind).join('')).toBe('   -+')
  expect(await createLocalSource({ cwd: root, target: sha }).fingerprint()).toBe(sha)
  await expect(readFullFile({ cwd: root, page: `/commit/${sha}`, path: 'nope.ts', colors })).rejects.toThrow('not in this review')
})
