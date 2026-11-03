import type { Lang, Theme } from '@pierre/highlights'
import type { CacheRepositories } from '@pulls.review/core/cache'
import type { DiffGroup, DiffGroupLeaf, DiffHunk, DiffSide, DiffsPayload, FileChange, GroupSource } from '@pulls.review/core/types'
import type { RunningState } from './schema'
import { codeToTokens, isSupportedLanguage } from '@pierre/highlights'
import { createRuleBasedAdapter, GENERATED_PATTERNS, TEST_PATTERNS } from '@pulls.review/core/analyze'
import { createCacheRepositories } from '@pulls.review/core/cache'
import { createLocalSource } from '@pulls.review/core/local'
import picomatch from 'picomatch'
import { createStorage } from 'unstorage'
import * as v from 'valibot'
import { createRepoCacheDriver, repoCacheDir } from '../storage'
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
  /** Left out unless asked for (`rows`): a large diff's rows run to megabytes. */
  hunks?: { header: string, rows: Row[] }[]
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

/** `text` highlighted line by line in the caller's colors. */
export function highlight(text: string, path: string, colors: Colors): Token[][] {
  const foreground = colors.foreground?.toLowerCase()
  const { tokens } = codeToTokens(text, { lang: languageOf(path), theme: themeFor(colors), tokenizeMaxLineLength: 2000 })
  return tokens.map(line => line.map(({ content, color }) => !color || color === foreground ? [content] : [content, color]))
}

/** A hunk's rows, each side highlighted as one text so a comment or string spanning lines keeps its color. */
export function hunkRows(hunk: DiffHunk, path: string, colors: Colors): Row[] {
  const lines = hunk.patch.split('\n').filter(line => line && !line.startsWith('\\') && !line.startsWith('@@'))
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
    // The new side's tokens come from the whole file, which reads each line in context.
    rows.push(...hunkRows(hunk, file.path, colors).map(row => row.new ? { ...row, tokens: lines[row.new - 1] ?? row.tokens } : row))
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

/** Mirrors the app's `resolveGroups` (`components/diff/group-utils.ts`), which the CLI cannot import: it needs vue-i18n. */
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

  const resolvedGroups: ReviewGroup[] = groups.map(group => ({ ...resolveLeaf(group), children: (group.children ?? []).map(child => ({ ...resolveLeaf(child), children: [] })) }))
  const uncategorized = files.filter(file => !referenced.has(file))
  if (uncategorized.length > 0)
    resolvedGroups.push({ key: 'uncategorized', label: 'Uncategorized', summary: 'Files not covered by the current analysis.', category: 'other', critical: false, files: uncategorized.map(file => file.path), missing: [], notes: {}, children: [] })
  return resolvedGroups
}

/** One repository's cache, shared by its worktrees as `<git-common-dir>/pulls-review` is. */
export function createReviewCaches() {
  const caches = new Map<string, Promise<CacheRepositories>>()
  return async (cwd: string): Promise<CacheRepositories> => {
    const dir = await repoCacheDir(cwd)
    let cache = caches.get(dir)
    if (!cache) {
      cache = createRepoCacheDriver(cwd).then(driver => createCacheRepositories(createStorage({ driver })))
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

export class ReviewError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/**
 * A review page as the pane draws it. The diff is fetched fresh and stored when it differs
 * from the cached one, as a page load with auto-refresh does: the saved analysis is kept,
 * and files reviewed before but changed since are flagged by `putDiff`.
 */
export async function readReview(options: {
  cwd: string
  page: string
  colors: Colors
  cache: CacheRepositories
  running: (key: string) => Promise<RunningState>
  agent: boolean
  /** The files whose highlighted rows to include; all of them when omitted. */
  rows?: string[]
}): Promise<Review> {
  const { cwd, page, colors, cache, running, agent } = options
  const wanted = options.rows && new Set(options.rows)
  const source = createLocalSource({ cwd, target: await pageTarget(cwd, page) })
  const [key, diff] = await Promise.all([source.key(), source.fetch()])
  const head = diff.head?.sha ?? ''
  const cached = await cache.diffs.get(key)
  const entry = cached?.headSha === head ? cached : await cache.diffs.putDiff(key, diff, head)
  const [reviewed, run] = await Promise.all([cache.reviewMarks.get(diff.files.map(file => file.sha)), running(key)])
  const llm = entry.analyzedBy.llm
  const groups = llm ?? await ruleBased.analyze(diff)
  const changed = new Set(entry.changedSinceReviewed)
  const state: AnalysisState = run.streamId ? 'running' : !llm ? 'none' : llm.headSha === head ? 'current' : 'outdated'
  return {
    key,
    title: diff.title,
    base: diff.base,
    head: diff.head,
    commits: (diff.commits ?? []).map(commit => ({ sha: commit.sha, subject: commit.message.split('\n')[0]!, author: commit.author?.name, date: commit.date })),
    source: llm ? 'llm' : 'rule-based',
    groups: resolveGroups(groups.groups, diff.files),
    files: diff.files.map(({ hunks, ...file }) => ({
      ...file,
      reviewed: reviewed.has(file.sha),
      changed: changed.has(file.path),
      noisy: isNoisy(file.path),
      test: isTest(file.path),
      ...!wanted || wanted.has(file.path) ? { hunks: hunks.map(hunk => ({ header: hunk.header, rows: hunkRows(hunk, file.path, colors) })) } : {},
    })),
    analysis: { state, model: llm?.model, generatedAt: llm?.generatedAt, progress: run.progress, error: run.error, agent },
  }
}

/** Sets reviewed marks and clears "changed since reviewed" for those files, as `DiffsStore.setReviewed` does. */
export async function setReviewed(options: { cwd: string, page: string, cache: CacheRepositories, shas: string[], reviewed: boolean }): Promise<void> {
  const { cwd, page, cache, shas, reviewed } = options
  await cache.reviewMarks.set(shas, reviewed)
  const key = await createLocalSource({ cwd, target: await pageTarget(cwd, page) }).key()
  const entry = await cache.diffs.get(key)
  if (!entry?.changedSinceReviewed?.length)
    return
  const touched = new Set(shas)
  const paths = new Set(entry.diff.files.filter(file => touched.has(file.sha)).map(file => file.path))
  const remaining = entry.changedSinceReviewed.filter(path => !paths.has(path))
  if (remaining.length !== entry.changedSinceReviewed.length)
    await cache.diffs.setChangedSinceReviewed(key, remaining)
}

/** One file's whole new side around its hunks, from the diff the page shows. */
export async function readFullFile(options: { cwd: string, page: string, path: string, colors: Colors }): Promise<Row[]> {
  const { cwd, page, path, colors } = options
  const source = createLocalSource({ cwd, target: await pageTarget(cwd, page) })
  const diff = await source.fetch()
  const file = diff.files.find(candidate => candidate.path === path)
  if (!file || !diff.head)
    throw new ReviewError(404, `${path} is not in this review`)
  const text = file.status === 'removed' ? undefined : await source.loadFile(path, diff.head.sha)
  if (text === undefined)
    throw new ReviewError(404, `No text for ${path}`)
  return fullRows(file, text, colors)
}
