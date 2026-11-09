import type { DiffGroup, FileChange } from '@pulls.review/core/types'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { createCacheRepositories } from '@pulls.review/core/cache'
import { createLocalSource } from '@pulls.review/core/local'
import { createStorage } from 'unstorage'
import { afterEach, expect, it, vi } from 'vitest'
import { fullRows, hunkRows, readFullFile, readReview, readRows, readStatus, resolveGroups, setReviewed } from './review'

const exec = promisify(execFile)
const colors = { foreground: '#cccccc', keyword: '#ff00ff', string: '#00ff00', comment: '#808080' }
let root: string | undefined
afterEach(async () => {
  if (root)
    await rm(root, { recursive: true, force: true })
})

async function repo() {
  // Canonical, as the registry passes a worktree's root.
  root = await realpath(await mkdtemp(join(tmpdir(), 'pulls-review-pane-')))
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

function file(path: string, extra: Partial<FileChange> = {}): FileChange {
  return { path, sha: path, status: 'modified', additions: 1, deletions: 0, isBinary: false, hunks: [{ header: '', oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, patch: '' }], ...extra }
}

it('resolves groups as the app does: renamed paths, missing paths, anchored notes and the rest uncategorized', () => {
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
  // Another size: git takes a same-size file written as it commits for unchanged.
  await writeFile(join(root, 'a.test.ts'), 'it("bb", () => {})\n')

  const first = await read()
  expect(first.source).toBe('rule-based')
  expect(first.groups.map(group => [group.label, group.files])).toEqual([['Code', ['a.ts']], ['Tests', ['a.test.ts']]])
  expect(first.files.find(file => file.path === 'a.test.ts')).toMatchObject({ test: true, noisy: false, reviewed: false, changed: false })
  expect(first.analysis).toEqual({ state: 'none', agent: true })
  // Rows only for the files asked for: a large diff's rows run to megabytes.
  const some = await readReview({ cwd: root, page: '/worktree', colors, cache, running: async () => ({}), agent: true, rows: ['a.ts'] })
  expect(some.files.map(file => [file.path, !!file.hunks])).toEqual([['a.test.ts', false], ['a.ts', true]])
  // An open's one read: the first group's rows as well as those asked for.
  const opened = await readReview({ cwd: root, page: '/worktree', colors, cache, running: async () => ({}), agent: true, rows: [], firstRows: true })
  expect(opened.files.map(file => [file.path, !!file.hunks])).toEqual([['a.test.ts', false], ['a.ts', true]])

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

it('says whether a page\'s analysis runs from its key, without reading the diff', async () => {
  const { root } = await repo()
  const cache = createCacheRepositories(createStorage())
  const { key } = await readReview({ cwd: root, page: '/worktree', colors, cache, running: async () => ({}), agent: false })
  const asked: string[] = []
  const running = async (key: string) => {
    asked.push(key)
    return { streamId: 's', progress: { step: 2, kind: 'thinking' as const } }
  }
  expect(await readStatus({ cwd: root, page: '/worktree', running })).toEqual({ running: true, progress: { step: 2, kind: 'thinking' } })
  expect(asked).toEqual([key])
  // The root comes canonical from the registry, so a poll starts no Git.
  vi.stubEnv('PATH', '/nonexistent')
  try {
    expect(await readStatus({ cwd: root, page: '/worktree', running: async () => ({ error: 'failed' }) })).toEqual({ running: false, error: 'failed' })
  }
  finally {
    vi.unstubAllEnvs()
  }
  // A range git can't resolve: its diff can't be read, its key can.
  await expect(readReview({ cwd: root, page: '/compare/nope...gone', colors, cache, running: async () => ({}), agent: false })).rejects.toThrow()
  expect(await readStatus({ cwd: root, page: '/compare/nope...gone', running: async () => ({}) })).toEqual({ running: false })
  await expect(readStatus({ cwd: root, page: '/elsewhere', running: async () => ({}) })).rejects.toThrow('No review at /elsewhere')
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

it('opens with the first group\'s rows only as far as 3000 changed lines go, and cuts every line at 1000 columns', async () => {
  const { root } = await repo()
  // Two files of 2000 lines in one group: rows for both would carry 4000.
  await writeFile(join(root, 'a.ts'), Array.from({ length: 2000 }, (_, i) => `const a${i} = ${i}`).join('\n'))
  await writeFile(join(root, 'b.ts'), `${'x'.repeat(5000)}\n${Array.from({ length: 1999 }, (_, i) => `const b${i} = ${i}`).join('\n')}`)
  const cache = createCacheRepositories(createStorage())
  const opened = await readReview({ cwd: root, page: '/worktree', colors, cache, running: async () => ({}), agent: false, rows: [], firstRows: true })
  expect(opened.groups[0]!.files).toEqual(['a.ts', 'b.ts'])
  expect(opened.files.filter(file => file.hunks).map(file => file.path)).toEqual(['a.ts'])
  const asked = await readReview({ cwd: root, page: '/worktree', colors, cache, running: async () => ({}), agent: false, rows: ['b.ts'] })
  const long = asked.files.find(file => file.path === 'b.ts')!.hunks!.flatMap(hunk => hunk.rows).find(row => row.new === 1)!
  expect(long.tokens.reduce((n, [text]) => n + text.length, 0)).toBe(1000)
})

it('drops a group none of whose files are left, keeping a parent whose subgroup still has some', () => {
  const groups: DiffGroup[] = [
    { key: 'gone', label: 'Gone', category: 'core', filePaths: ['gone.ts'], children: [{ key: 'gone-child', label: 'Gone too', category: 'core', filePaths: ['also-gone.ts'] }] },
    { key: 'parent', label: 'Parent', category: 'core', filePaths: ['gone.ts'], children: [{ key: 'empty', label: 'Empty', category: 'core', filePaths: [] }, { key: 'kept', label: 'Kept', category: 'core', filePaths: ['b.ts'] }] },
  ]
  const resolved = resolveGroups(groups, [file('b.ts'), file('c.ts')])
  expect(resolved.map(group => [group.key, group.children.map(child => child.key)])).toEqual([['parent', ['kept']], ['uncategorized', []]])
})

it('shows no analysis once a range holds none of its files, as after a push and new commits', async () => {
  const { root, git } = await repo()
  await git('branch', 'pushed')
  await writeFile(join(root, 'a.ts'), 'const a = 2\n')
  await git('commit', '-am', 'two')
  const cache = createCacheRepositories(createStorage())
  const read = () => readReview({ cwd: root, page: '/compare/pushed...main', colors, cache, running: async () => ({}), agent: false })
  const { key } = await read()
  await cache.diffs.setAnalyzedResult(key, 'llm', { source: 'llm', groups: [{ key: 'x', label: 'The change', category: 'core', filePaths: ['a.ts'] }], schemaVersion: 1, generatedAt: '2026-01-01T00:00:00.000Z', model: 'pi/m', headSha: (await git('rev-parse', 'HEAD')).stdout.trim() })
  await git('branch', '-f', 'pushed', 'main')
  await writeFile(join(root, 'a.test.ts'), 'it("b", () => {})\n')
  await git('commit', '-am', 'three')
  const other = await read()
  expect([other.files.map(f => f.path), other.source, other.analysis.state, other.groups.some(group => group.key === 'x')]).toEqual([['a.test.ts'], 'rule-based', 'none', false])
})

it('keeps an analysis whose own group is keyed uncategorized: its files decide, not its keys', async () => {
  const { root } = await repo()
  const cache = createCacheRepositories(createStorage())
  const read = () => readReview({ cwd: root, page: '/worktree', colors, cache, running: async () => ({}), agent: false })
  await writeFile(join(root, 'a.ts'), 'const a = 2\n')
  const { key, head } = await read()
  await cache.diffs.setAnalyzedResult(key, 'llm', { source: 'llm', groups: [{ key: 'uncategorized', label: 'Odds and ends', category: 'core', filePaths: ['a.ts'] }], schemaVersion: 1, generatedAt: 'now', headSha: head!.sha, model: 'pi/m' })
  const shown = await read()
  expect([shown.source, shown.analysis.state, shown.groups.map(group => group.label)]).toEqual(['llm', 'current', ['Odds and ends']])
})

it('evicts the page read least lately, a cached page\'s read counting as one', async () => {
  const { root, git } = await repo()
  const sha = async () => (await git('rev-parse', 'HEAD')).stdout.trim()
  const shas = [await sha()]
  for (const text of ['2', '3']) {
    await writeFile(join(root, 'a.ts'), `const a = ${text}\n`)
    await git('commit', '-am', text)
    shas.push(await sha())
  }
  const cache = createCacheRepositories(createStorage(), { maxEntries: 2 })
  const read = (page: string) => readReview({ cwd: root, page, colors, cache, running: async () => ({}), agent: false, rows: [] })
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const at = async (time: number, page: string) => {
      vi.setSystemTime(time)
      return (await read(page)).key
    }
    const worktree = await at(1000, '/worktree')
    const a = await at(2000, `/commit/${shas[1]}`)
    await at(3000, '/worktree')
    await at(4000, `/commit/${shas[2]}`)
    expect([!!await cache.diffs.get(worktree), !!await cache.diffs.get(a)]).toEqual([true, false])
  }
  finally {
    vi.useRealTimers()
  }
})

it('has nothing to review once a range is empty, its analysis kept for when it isn\'t', async () => {
  const { root, git } = await repo()
  await git('branch', 'pushed')
  await writeFile(join(root, 'a.ts'), 'const a = 2\n')
  await git('commit', '-am', 'two')
  const cache = createCacheRepositories(createStorage())
  const read = () => readReview({ cwd: root, page: '/compare/pushed...main', colors, cache, running: async () => ({}), agent: false })
  const { key } = await read()
  await cache.diffs.setAnalyzedResult(key, 'llm', { source: 'llm', groups: [{ key: 'x', label: 'The change', category: 'core', filePaths: ['a.ts'] }], schemaVersion: 1, generatedAt: '2026-01-01T00:00:00.000Z', model: 'pi/m', headSha: (await git('rev-parse', 'HEAD')).stdout.trim() })
  expect((await read()).analysis.state).toBe('current')
  // Pushed: the base reaches the head, which stays the same, so the analysis's head still matches a diff with nothing in it.
  await git('branch', '-f', 'pushed', 'main')
  const empty = await read()
  expect([empty.files, empty.groups, empty.source, empty.analysis.state]).toEqual([[], [], 'rule-based', 'none'])
})

it('reads a file\'s whole new side for a commit page', async () => {
  const { root, git } = await repo()
  await writeFile(join(root, 'a.ts'), 'const a = 1\n/* one\n   two */\nexport { a, b }\n')
  await git('commit', '-am', 'export b')
  const sha = (await git('rev-parse', 'HEAD')).stdout.trim()
  const { rows } = await readFullFile({ cwd: root, page: `/commit/${sha}`, path: 'a.ts', colors })
  expect(rows.map(row => row.kind).join('')).toBe('   -+')
  expect(await createLocalSource({ cwd: root, target: sha }).fingerprint()).toBe(sha)
  await expect(readFullFile({ cwd: root, page: `/commit/${sha}`, path: 'nope.ts', colors })).rejects.toThrow('not in this review')
})

// Herdr reads at most 8 MiB a response; the cases the audit measured past it.
const LIMIT = 8 * 1024 * 1024
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

it('keeps a read\'s rows under what Herdr reads, cutting a file too big by itself and leaving the rest for a later read', async () => {
  const { root } = await repo()
  // Each line is a run of tokens: 1000 lines weigh about 3.5 MB of JSON.
  for (const name of ['a.js', 'b.js', 'c.js'])
    await writeFile(join(root, name), `${'1+'.repeat(160)}1\n`.repeat(1000))
  const cache = createCacheRepositories(createStorage())
  const read = (rows: string[], firstRows = false) => readReview({ cwd: root, page: '/worktree', colors: { ...colors, number: '#d19a66' }, cache, running: async () => ({}), agent: false, rows, firstRows })
  const opened = await read([], true)
  expect(bytes(opened)).toBeLessThan(LIMIT)
  expect(opened.files.filter(file => file.hunks).map(file => [file.path, file.clipped ?? false])).toEqual([['a.js', false]])
  const asked = await read(['b.js', 'c.js'])
  expect(bytes(asked)).toBeLessThan(LIMIT)
  expect(asked.files.filter(file => file.hunks).map(file => file.path)).toEqual(['b.js'])

  // One file of 170,000 short lines: by itself past the limit, so cut and marked, and its whole side read without overflowing the stack.
  await writeFile(join(root, 'a.js'), '1\n'.repeat(170000))
  const big = await read(['a.js'])
  const file = big.files.find(file => file.path === 'a.js')!
  expect([bytes(big) < LIMIT, file.clipped, file.hunks![0]!.rows.length < 170000]).toEqual([true, true, true])
  const whole = await readFullFile({ cwd: root, page: '/worktree', path: 'a.js', colors })
  expect([bytes(whole) < LIMIT, whole.truncated]).toEqual([true, true])
}, 60_000)

it('cuts a whole file past what Herdr reads, and marks it truncated', async () => {
  const { root } = await repo()
  await writeFile(join(root, 'a.txt'), `${'x'.repeat(1000)}\n`.repeat(9000))
  const whole = await readFullFile({ cwd: root, page: '/worktree', path: 'a.txt', colors })
  expect([bytes(whole) < LIMIT, whole.truncated, whole.rows.length > 1000]).toEqual([true, true, true])
  await writeFile(join(root, 'a.txt'), 'x\n')
  expect(await readFullFile({ cwd: root, page: '/worktree', path: 'a.txt', colors })).not.toHaveProperty('truncated')
})

it('reads only the asked files\' rows from the diff the pane shows, and says when that isn\'t the one cached', async () => {
  const { root } = await repo()
  await writeFile(join(root, 'a.ts'), 'const a = 2\n/* one\n   two */\nexport { a }\n')
  await writeFile(join(root, 'b.ts'), 'export const b = 1\n')
  const cache = createCacheRepositories(createStorage())
  const shown = await readReview({ cwd: root, page: '/worktree', colors, cache, running: async () => ({}), agent: false, rows: [] })
  const shas = { base: shown.base!.sha, head: shown.head!.sha }
  const rows = await readRows({ cwd: root, page: '/worktree', colors, cache, files: ['b.ts'], ...shas })
  expect(rows).toEqual({ files: [{ path: 'b.ts', sha: shown.files.find(file => file.path === 'b.ts')!.sha, hunks: [{ header: expect.any(String), rows: [expect.objectContaining({ kind: '+', new: 1 })] }] }] })
  // Changed since, the page isn't read again: the rows are still the shown diff's.
  await writeFile(join(root, 'b.ts'), 'export const b = 2\nexport const c = 3\n')
  expect((await readRows({ cwd: root, page: '/worktree', colors, cache, files: ['b.ts'], ...shas }) as any).files[0].hunks[0].rows).toHaveLength(1)
  expect(await readRows({ cwd: root, page: '/worktree', colors, cache, files: ['b.ts'], ...shas, head: 'other' })).toEqual({ stale: true })
  expect(await readRows({ cwd: root, page: '/worktree', colors, cache: createCacheRepositories(createStorage()), files: ['b.ts'], ...shas })).toEqual({ stale: true })
})

it('pages a file too big for one read, by itself and as a whole file, end to end', async () => {
  const { root } = await repo()
  await writeFile(join(root, 'a.js'), '1\n'.repeat(170000))
  const cache = createCacheRepositories(createStorage())
  const page = '/worktree'
  const pageColors = { ...colors, number: '#d19a66' }
  const shown = await readReview({ cwd: root, page, colors: pageColors, cache, running: async () => ({}), agent: false, rows: ['a.js'] })
  const shas = { base: shown.base!.sha, head: shown.head!.sha }
  const first = shown.files.find(file => file.path === 'a.js')!
  const diff = [...first.hunks!]
  let clipped = first.clipped
  for (let pages = 1; clipped; pages++) {
    expect(pages).toBeLessThan(10)
    const next = await readRows({ cwd: root, page, colors: pageColors, cache, files: ['a.js'], ...shas, from: diff.flatMap(hunk => hunk.rows).length })
    if (!('files' in next))
      throw new Error('stale')
    expect(bytes(next)).toBeLessThan(LIMIT)
    // Going on from the hunk before, a page's first hunk has no header.
    expect(next.files[0]!.hunks![0]).not.toHaveProperty('header')
    diff.push(...next.files[0]!.hunks!)
    clipped = next.files[0]!.clipped
  }
  expect(diff.flatMap(hunk => hunk.rows).map(row => row.new)).toEqual(Array.from({ length: 170000 }, (_, i) => i + 1))

  const whole: number[] = []
  for (let truncated: true | undefined = true, pages = 0; truncated; pages++) {
    expect(pages).toBeLessThan(10)
    const next = await readFullFile({ cwd: root, page, path: 'a.js', colors: pageColors, from: whole.length })
    expect(bytes(next)).toBeLessThan(LIMIT)
    whole.push(...next.rows.map(row => row.new!))
    truncated = next.truncated
  }
  expect(whole).toEqual(Array.from({ length: 170000 }, (_, i) => i + 1))
}, 120_000)
