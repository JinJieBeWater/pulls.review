import type { Lang, Theme } from '@pierre/highlights'
import type { CacheRepositories, PrCacheEntry } from '@pulls.review/core/cache'
import type { LocalSource } from '@pulls.review/core/local'
import type { DiffGroup, DiffGroupLeaf, DiffHunk, DiffSide, DiffsPayload, FileChange, GroupSource } from '@pulls.review/core/types'
import type { RunningState } from './schema'
import { Buffer } from 'node:buffer'
import { codeToTokens, isSupportedLanguage } from '@pierre/highlights'
import { createRuleBasedAdapter, GENERATED_PATTERNS, TEST_PATTERNS } from '@pulls.review/core/analyze'
import { createLocalSource } from '@pulls.review/core/local'
import { serializeRef } from '@pulls.review/core/types'
import picomatch from 'picomatch'
import * as v from 'valibot'
import { createRepoCaches, repoCacheDir } from '../storage'
import { targetForPage } from './analysis'

/** Syntax kinds the caller colors; `foreground` is everything else (plans/fork/04). */
const COLOR_KINDS = ['foreground', 'keyword', 'string', 'comment', 'function', 'type', 'number', 'constant', 'boolean', 'property', 'variable', 'operator', 'punctuation', 'tag', 'attribute'] as const
export const ColorsSchema = v.record(v.picklist(COLOR_KINDS), v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i)))
export type Colors = v.InferOutput<typeof ColorsSchema>

/** One styled run: its text, and its color unless it is the foreground. */
export type Token = [text: string] | [text: string, color: string]
export interface Row {
  kind: ' ' | '+' | '-'
  old?: number
  new?: number
  tokens: Token[]
  /** How wide its tokens draw (`columnsOf`), on every row a read sends. */
  columns?: number
}
export interface ReviewNote {
  text: string
  critical: boolean
  /** Only where a hunk shows that line, as the app's `resolveLineNote`. */
  anchor?: { side: DiffSide, line: number }
}
export interface ReviewGroup {
  key: string
  label: string
  summary?: string
  category: string
  critical: boolean
  files: string[]
  /** Paths the analysis named that left the diff. */
  missing: string[]
  notes: Record<string, ReviewNote[]>
  children: ReviewGroup[]
}
export interface ReviewFile extends Omit<FileChange, 'hunks'> {
  reviewed: boolean
  /** Reviewed once, changed since. */
  changed: boolean
  noisy: boolean
  test: boolean
  /** Left out unless asked for (`rows`): a large diff's rows run to megabytes. No `header`: a page's first hunk, which goes on from the one before. */
  hunks?: { header?: string, rows: Row[] }[]
  /** Its rows stop early: by themselves they ran past what one read carries (`Budget`). */
  clipped?: true
}
export type AnalysisState = 'none' | 'current' | 'outdated' | 'running'

// The app's English rule text (`locales/en.json` `rules.*`): the pane has no locale of its own.
const RULE_TEXT = {
  code: ['Code', 'Source changes.'],
  other: ['Other', 'Other changes that don\'t fit an existing category.'],
  docs: ['Docs', 'Documentation updates.'],
  tests: ['Tests', 'Test coverage for the change.'],
  config: ['Config', 'Configuration changes.'],
  deps: ['Dependencies', 'Dependency version changes.'],
  generated: ['Generated', 'Generated or build output changes.'],
  assets: ['Assets', 'Vector images and icons.'],
} as const
const ruleBased = createRuleBasedAdapter(key => ({ label: RULE_TEXT[key][0], summary: RULE_TEXT[key][1] }))
const isNoisy = picomatch(GENERATED_PATTERNS)
const isTest = picomatch(TEST_PATTERNS)

function languageOf(path: string): Lang {
  const name = path.split('/').pop()!.toLowerCase()
  const ext = name.includes('.') ? name.split('.').pop()! : name
  return (isSupportedLanguage(ext) ? ext : 'plain') as Lang
}

const themes = new Map<string, Theme>()
function themeFor(colors: Colors): Theme {
  const id = JSON.stringify(colors)
  let theme = themes.get(id)
  if (!theme) {
    const { foreground = '#808080', ...syntax } = colors
    theme = { name: 'herdr', appearance: 'dark', style: { foreground, syntax: Object.fromEntries(Object.entries(syntax).map(([kind, color]) => [kind, { color }])) } }
    themes.set(id, theme)
  }
  return theme
}

/** Where the pane stops drawing a line: a log's or a minified file's lines would otherwise run a read to megabytes. */
const MAX_COLUMNS = 1000

/** `text` highlighted line by line in the caller's colors, each line cut at MAX_COLUMNS characters. */
export function highlight(text: string, path: string, colors: Colors): Token[][] {
  const foreground = colors.foreground?.toLowerCase()
  const { tokens } = codeToTokens(text, { lang: languageOf(path), theme: themeFor(colors), tokenizeMaxLineLength: 2000 })
  return tokens.map((line) => {
    const out: Token[] = []
    let left = MAX_COLUMNS
    for (const { content, color } of line) {
      if (left <= 0)
        break
      const text = content.slice(0, left)
      out.push(!color || color === foreground ? [text] : [text, color])
      left -= content.length
    }
    return out
  })
}

// Wide (CJK and up) counts 2: a BMP character is 1 unit plus 1 here; an astral one, 2 units (surrogates aren't matched).
const WIDE = /[\u2E80-\uD7FF\uE000-\uFFFF]/g

/** The columns tokens take as the pane draws them, a tab 4: the pane's own rule (`rows.js` in herdr-t3), kept by shared cases. */
export function columnsOf(tokens: Token[]): number {
  return tokens.reduce((n, [text]) => {
    const spaced = text.replaceAll('\t', '    ')
    return n + spaced.length + (spaced.match(WIDE)?.length ?? 0)
  }, 0)
}

/** A hunk's patch lines, one a row. */
const patchLines = (hunk: DiffHunk) => hunk.patch.split('\n').filter(line => line && !line.startsWith('\\') && !line.startsWith('@@'))

/** A hunk's rows, each side highlighted as one text so a comment or string spanning lines keeps its color. */
export function hunkRows(hunk: DiffHunk, path: string, colors: Colors): Row[] {
  const lines = patchLines(hunk)
  const side = (keep: string) => highlight(lines.filter(line => keep.includes(line[0]!)).map(line => line.slice(1)).join('\n'), path, colors)
  const olds = side(' -')
  const news = side(' +')
  let old = hunk.oldStart
  let next = hunk.newStart
  let o = 0
  let n = 0
  return lines.map((line) => {
    if (line[0] === '-')
      return { kind: '-', old: old++, tokens: olds[o++] ?? [] }
    if (line[0] === '+')
      return { kind: '+', new: next++, tokens: news[n++] ?? [] }
    o++
    return { kind: ' ', old: old++, new: next++, tokens: news[n++] ?? [] }
  })
}

/** The whole new side of a file with its hunks in place: lines outside them are context. */
export function fullRows(file: Pick<FileChange, 'path' | 'hunks'>, text: string, colors: Colors): Row[] {
  const lines = highlight(text.replace(/\n$/, ''), file.path, colors)
  const rows: Row[] = []
  let next = 1
  let offset = 0
  const context = (until: number) => {
    for (; next < until && next <= lines.length; next++)
      rows.push({ kind: ' ', old: next + offset, new: next, tokens: lines[next - 1]! })
  }
  for (const hunk of [...file.hunks].sort((a, b) => a.newStart - b.newStart)) {
    context(hunk.newLines ? hunk.newStart : hunk.newStart + 1)
    // The new side's tokens come from the whole file, which reads each line in context. One push a row: a spread of a
    // hunk's rows passes as many arguments, past the stack for a file of a few hundred thousand lines.
    for (const row of hunkRows(hunk, file.path, colors))
      rows.push(row.new ? { ...row, tokens: lines[row.new - 1] ?? row.tokens } : row)
    // An empty side's start is the line before it.
    next = hunk.newStart + hunk.newLines + (hunk.newLines ? 0 : 1)
    offset = hunk.oldStart + hunk.oldLines + (hunk.oldLines ? 0 : 1) - next
  }
  context(lines.length + 1)
  return rows
}

function hunkShowsLine(file: FileChange, side: DiffSide, line: number): boolean {
  return file.hunks.some((hunk) => {
    const [start, count] = side === 'additions' ? [hunk.newStart, hunk.newLines] : [hunk.oldStart, hunk.oldLines]
    return line >= start && line < start + count
  })
}

const UNCATEGORIZED = 'uncategorized'

/**
 * Mirrors the app's `resolveGroups` (`components/diff/group-utils.ts`), which the CLI cannot import: it needs vue-i18n.
 * Unlike the app's, a group none of whose files are left is dropped: a local page's key outlives the files it held.
 */
export function resolveGroups(groups: DiffGroup[], files: FileChange[]): ReviewGroup[] {
  const byPath = new Map(files.map(file => [file.path, file]))
  const byPreviousPath = new Map(files.flatMap(file => file.previousPath ? [[file.previousPath, file] as const] : []))
  const find = (path: string) => byPath.get(path) ?? byPreviousPath.get(path)
  const referenced = new Set<FileChange>()

  function resolveLeaf(leaf: DiffGroupLeaf): Omit<ReviewGroup, 'children'> {
    const resolved: string[] = []
    const missing: string[] = []
    for (const path of leaf.filePaths) {
      const file = find(path)
      if (file) {
        resolved.push(file.path)
        referenced.add(file)
      }
      else {
        missing.push(path)
      }
    }
    const notes: Record<string, ReviewNote[]> = {}
    const attach = (path: string, note: (file: FileChange) => ReviewNote) => {
      const file = find(path)
      if (file)
        (notes[file.path] ??= []).push(note(file))
    }
    for (const note of leaf.fileNotes ?? [])
      attach(note.path, () => ({ text: note.text, critical: note.critical ?? false }))
    for (const note of leaf.lineNotes ?? []) {
      attach(note.path, (file): ReviewNote => ({
        text: note.text,
        critical: note.critical ?? false,
        ...hunkShowsLine(file, note.side, note.line) ? { anchor: { side: note.side, line: note.line } } : {},
      }))
    }
    return {
      key: leaf.key,
      label: leaf.label,
      summary: leaf.summary,
      category: leaf.category ?? 'other',
      critical: (leaf.critical ?? false) || Object.values(notes).flat().some(note => note.critical),
      files: resolved,
      missing,
      notes,
    }
  }

  const resolvedGroups: ReviewGroup[] = groups
    .map(group => ({ ...resolveLeaf(group), children: (group.children ?? []).map(child => ({ ...resolveLeaf(child), children: [] })).filter(child => child.files.length) }))
    .filter(group => group.files.length || group.children.length)
  const uncategorized = files.filter(file => !referenced.has(file))
  if (uncategorized.length > 0)
    resolvedGroups.push({ key: UNCATEGORIZED, label: 'Uncategorized', summary: 'Files not covered by the current analysis.', category: 'other', critical: false, files: uncategorized.map(file => file.path), missing: [], notes: {}, children: [] })
  return resolvedGroups
}

/** One repository's cache, shared by its worktrees as `<git-common-dir>/pulls-review` is. */
export function createReviewCaches() {
  const caches = new Map<string, Promise<CacheRepositories>>()
  // A registered worktree's common dir doesn't move: found once, not one Git a read. A failure is asked again.
  const dirs = new Map<string, Promise<string>>()
  return async (cwd: string): Promise<CacheRepositories> => {
    let found = dirs.get(cwd)
    if (!found) {
      found = repoCacheDir(cwd).catch((error) => {
        dirs.delete(cwd)
        throw error
      })
      dirs.set(cwd, found)
    }
    const dir = await found
    let cache = caches.get(dir)
    if (!cache) {
      cache = createRepoCaches(cwd)
      caches.set(dir, cache)
    }
    return cache
  }
}

export interface Review {
  key: string
  title: string
  base?: DiffsPayload['base']
  head?: DiffsPayload['head']
  commits: { sha: string, subject: string, author?: string, date?: string }[]
  source: GroupSource
  groups: ReviewGroup[]
  files: ReviewFile[]
  analysis: { state: AnalysisState, model?: string, generatedAt?: string, progress?: RunningState['progress'], error?: string, agent: boolean }
}

/** A page's target, or a 400 for a page without one. */
export async function pageTarget(cwd: string, page: string): Promise<string> {
  const target = await targetForPage(cwd, page)
  if (target === undefined)
    throw new ReviewError(400, `No review at ${page}`)
  return target
}

/** A page's cache key, which needs no diff. `cwd` is the registry's worktree root, canonical as Git's `--show-toplevel`. */
async function pageKey(cwd: string, page: string): Promise<string> {
  return serializeRef({ kind: 'local', repo: cwd, target: await pageTarget(cwd, page) })
}

export class ReviewError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/**
 * What one read's rows still carry. `bytes` of JSON, about 600 KB: the pane parses a read on its one thread, and with a large
 * page's files and groups (444 KB measured) a read stays near 1 MiB; a line's tokens can outweigh its text many times.
 * `rows` and `tokens` bound what the pane builds from one read, where bytes alone let through 80,000 short rows or 320,000
 * tokens. They don't make it fit one render: a real first read of 2,865 rows and 9,185 tokens ran past the 50 ms Herdr allows.
 * shortcut: the page's files and groups aren't counted; a page of 10,000 files takes about 4 MiB of them, count them if one comes near.
 */
interface Budget { bytes: number, rows: number, tokens: number }
const readBudget = (): Budget => ({ bytes: 600 * 1024, rows: 3000, tokens: 10_000 })

/** How many of `rows`, from the first, fit in what `left` carries, taken from it. Each gets its `columns`, counted too. */
function rowsWithin(rows: Row[], left: Budget): number {
  for (const [index, row] of rows.entries()) {
    row.columns = columnsOf(row.tokens)
    const bytes = Buffer.byteLength(JSON.stringify(row)) + 1
    if (bytes > left.bytes || left.rows < 1 || row.tokens.length > left.tokens)
      return index
    left.bytes -= bytes
    left.rows--
    left.tokens -= row.tokens.length
  }
  return rows.length
}

/** A file's rows from its `from`th on, while `left` lasts, and whether that cut them short. */
function fileRows(file: FileChange, colors: Colors, left: Budget, from = 0): { hunks: NonNullable<ReviewFile['hunks']>, clipped: boolean } {
  const hunks: NonNullable<ReviewFile['hunks']> = []
  let skip = from
  for (const hunk of file.hunks) {
    // The hunks a page already sent are counted, not highlighted.
    const lines = patchLines(hunk).length
    if (skip >= lines) {
      skip -= lines
      continue
    }
    const rows = hunkRows(hunk, file.path, colors).slice(skip)
    const head = skip ? {} : { header: hunk.header }
    skip = 0
    left.bytes -= Buffer.byteLength(JSON.stringify(head)) + 12
    const count = rowsWithin(rows, left)
    if (count < rows.length) {
      if (count)
        hunks.push({ ...head, rows: rows.slice(0, count) })
      return { hunks, clipped: true }
    }
    hunks.push({ ...head, rows })
  }
  return { hunks, clipped: false }
}

/**
 * The rows of `paths`, in order, each file whole while one read's budget lasts: the files past it get none, for a later read.
 * The first is cut there instead, `clipped`: by itself it can run past what a read carries. It starts at its `from`th row.
 */
function servedRows(paths: string[], files: FileChange[], colors: Colors, from = 0): Map<string, Pick<ReviewFile, 'hunks' | 'clipped'>> {
  const byPath = new Map(files.map(file => [file.path, file]))
  const served = new Map<string, Pick<ReviewFile, 'hunks' | 'clipped'>>()
  const left = readBudget()
  for (const path of new Set(paths)) {
    const file = byPath.get(path)
    if (!file)
      continue
    const { hunks, clipped } = fileRows(file, colors, left, path === paths[0] ? from : 0)
    if (clipped && served.size)
      break
    served.set(path, clipped ? { hunks, clipped: true } : { hunks })
    if (clipped)
      break
  }
  return served
}

/**
 * Per cache, the diffs this process stored, `key\0base\0head`. Only they are served without a fetch: a diff another
 * daemon version stored, with another parser or cut, is read again once a process and stored over.
 */
const stored = new WeakMap<CacheRepositories, Set<string>>()

/**
 * A page's diff, as cached while its base and head shas still name it, with no Git diff or log; else fetched and stored,
 * a range's base moving under the same head too. The working tree has no sha before its diff, so it is always fetched.
 */
async function pageEntry(source: LocalSource, cache: CacheRepositories): Promise<{ key: string, entry: PrCacheEntry }> {
  const [key, at] = await Promise.all([source.key(), source.revisions()])
  let seen = stored.get(cache)
  if (!seen)
    stored.set(cache, seen = new Set())
  const cached = await cache.diffs.get(key)
  const holds = (base: string | undefined, head: string) => cached?.headSha === head && cached.diff.base?.sha === base && seen.has(`${key}\0${base}\0${head}`)
  // A hit is a view too: eviction goes by `lastViewedAt`, and a page read often must outlast one read once.
  if (at.head && holds(at.base, at.head)) {
    await cache.diffs.touch(key)
    return { key, entry: cached! }
  }
  const diff = await source.fetch()
  const head = diff.head?.sha ?? ''
  const entry = holds(diff.base?.sha, head) ? (await cache.diffs.touch(key), cached!) : await cache.diffs.putDiff(key, diff, head)
  seen.add(`${key}\0${diff.base?.sha}\0${head}`)
  return { key, entry }
}

export async function readReview(options: {
  cwd: string
  page: string
  colors: Colors
  cache: CacheRepositories
  running: (key: string) => Promise<RunningState>
  agent: boolean
  /** The files whose highlighted rows to include, in order while one read's budget lasts (`servedRows`); all of them when omitted. */
  rows?: string[]
  /** The first group's files, its own and its children's as the pane's `groupFiles`, get their rows too, so an open needs one read (plans/fork/05). */
  firstRows?: boolean
}): Promise<Review> {
  const { cwd, page, colors, cache, running, agent } = options
  const source = createLocalSource({ cwd, target: await pageTarget(cwd, page) })
  // The cache then holds the diff last read, which `readRows` serves.
  const { key, entry } = await pageEntry(source, cache)
  const { diff } = entry
  const head = diff.head?.sha ?? ''
  // A run that can't be asked about isn't over: the read still shows the page, with why the state is unknown.
  const [reviewed, run] = await Promise.all([cache.reviewMarks.get(diff.files.map(file => file.sha)), running(key).catch((error): RunningState => ({ error: `Can't tell whether an analysis runs: ${error instanceof Error ? error.message : error}` }))])
  // A range's key outlives its commits: with none of its files left, the analysis was of other files.
  // shortcut: a base moved partway keeps the analysis current, pushed files shown missing; stamp the base if that misleads.
  const paths = new Set(diff.files.flatMap(file => file.previousPath ? [file.path, file.previousPath] : [file.path]))
  const saved = entry.analyzedBy.llm
  const llm = saved?.groups.some(group => [group, ...group.children ?? []].some(leaf => leaf.filePaths.some(path => paths.has(path)))) ? saved : undefined
  const changed = new Set(entry.changedSinceReviewed)
  const state: AnalysisState = run.streamId ? 'running' : !llm ? 'none' : llm.headSha === head ? 'current' : 'outdated'
  const resolved = resolveGroups(llm ? llm.groups : (await ruleBased.analyze(diff)).groups, diff.files)
  const first = options.firstRows ? resolved[0] : undefined
  const served = servedRows(options.rows ? [...options.rows, ...first ? [first, ...first.children].flatMap(group => group.files) : []] : diff.files.map(file => file.path), diff.files, colors)
  return {
    key,
    title: diff.title,
    base: diff.base,
    head: diff.head,
    commits: (diff.commits ?? []).map(commit => ({ sha: commit.sha, subject: commit.message.split('\n')[0]!, author: commit.author?.name, date: commit.date })),
    source: llm ? 'llm' : 'rule-based',
    groups: resolved,
    files: diff.files.map(({ hunks: _, ...file }) => ({
      ...file,
      reviewed: reviewed.has(file.sha),
      changed: changed.has(file.path),
      noisy: isNoisy(file.path),
      test: isTest(file.path),
      ...served.get(file.path),
    })),
    analysis: { state, model: llm?.model, generatedAt: llm?.generatedAt, progress: run.progress, error: run.error, agent },
  }
}

/**
 * Only `files`' rows, as `readReview` serves them (`servedRows`), from the diff the pane shows, named by its `base` and `head`
 * shas: that's the one the cache holds, last read, so no Git diff runs. Any other, `stale`: the pane reads the page again.
 */
export async function readRows(options: { cwd: string, page: string, colors: Colors, cache: CacheRepositories, files: string[], base: string, head: string, from?: number }): Promise<{ files: Pick<ReviewFile, 'path' | 'sha' | 'hunks' | 'clipped'>[] } | { stale: true }> {
  const { cwd, page, colors, cache, files, base, head, from } = options
  const entry = await cache.diffs.get(await pageKey(cwd, page))
  if (!entry || (entry.diff.base?.sha ?? '') !== base || (entry.diff.head?.sha ?? '') !== head)
    return { stale: true }
  const served = servedRows(files, entry.diff.files, colors, from)
  return { files: entry.diff.files.flatMap(file => served.has(file.path) ? [{ path: file.path, sha: file.sha, ...served.get(file.path) }] : []) }
}

/** Whether a page's analysis runs, from its key and the worktree server alone: polling a run reads no diff (plans/fork/05). */
export async function readStatus(options: { cwd: string, page: string, running: (key: string) => Promise<RunningState> }): Promise<{ running: boolean, progress?: RunningState['progress'], error?: string }> {
  const { streamId, progress, error } = await options.running(await pageKey(options.cwd, options.page))
  return { running: !!streamId, progress, error }
}

/** Sets reviewed marks and clears "changed since reviewed" for those files, as `DiffsStore.setReviewed` does. */
export async function setReviewed(options: { cwd: string, page: string, cache: CacheRepositories, shas: string[], reviewed: boolean }): Promise<void> {
  const { cwd, page, cache, shas, reviewed } = options
  await cache.reviewMarks.set(shas, reviewed)
  const key = await pageKey(cwd, page)
  const entry = await cache.diffs.get(key)
  if (!entry?.changedSinceReviewed?.length)
    return
  const touched = new Set(shas)
  const paths = new Set(entry.diff.files.filter(file => touched.has(file.sha)).map(file => file.path))
  const remaining = entry.changedSinceReviewed.filter(path => !paths.has(path))
  if (remaining.length !== entry.changedSinceReviewed.length)
    await cache.diffs.setChangedSinceReviewed(key, remaining)
}

/**
 * One file's whole new side around its hunks, from the diff the page shows, from its `from`th row on; `truncated` past
 * what one read carries (`Budget`), the rest for a read from where it stops.
 * shortcut: each page highlights the whole file again (a 170,000-line one takes seconds); keep its tokens if paging drags.
 */
export async function readFullFile(options: { cwd: string, page: string, path: string, colors: Colors, cache: CacheRepositories, from?: number }): Promise<{ rows: Row[], truncated?: true }> {
  const { cwd, page, path, colors, cache, from = 0 } = options
  const source = createLocalSource({ cwd, target: await pageTarget(cwd, page) })
  const { diff } = (await pageEntry(source, cache)).entry
  const file = diff.files.find(candidate => candidate.path === path)
  if (!file || !diff.head)
    throw new ReviewError(404, `${path} is not in this review`)
  const text = file.status === 'removed' ? undefined : await source.loadFile(path, diff.head.sha)
  if (text === undefined)
    throw new ReviewError(404, `No text for ${path}`)
  const rows = fullRows(file, text, colors).slice(from)
  const count = rowsWithin(rows, readBudget())
  return count < rows.length ? { rows: rows.slice(0, count), truncated: true } : { rows }
}
