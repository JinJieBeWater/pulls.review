import type { SelectedLineRange } from '@pierre/diffs'
import type { Note, NoteChange } from '@pulls.review/core/local-rpc'
import type { CommentThread, DiffSource, DiffsPayload, ReviewsApi } from '@pulls.review/core/types'
import type { Storage } from 'unstorage'
import { createCacheRepositories } from '@pulls.review/core/cache'
import { NoteSchema } from '@pulls.review/core/local-rpc'
import * as v from 'valibot'
import { buildChatQuote, withQuotes } from '../components/chat/chat-quotes'

/**
 * Notes on a local review: change requests for an agent, copied to it as Markdown
 * (plans/fork/02). Served through upstream's `ReviewsApi`, so `FileDiff.vue` keeps its
 * gutter, selection and line slots: a note is a one-comment thread, unsent is `pending`.
 */
export type { Note } from '@pulls.review/core/local-rpc'

function rangeOf(note: Pick<Note, 'line' | 'side' | 'startLine' | 'startSide'>): SelectedLineRange {
  return { start: note.startLine ?? note.line, side: note.startSide ?? note.side, end: note.line, endSide: note.side }
}

/** A note's thread in `diff`; outdated (hidden) where its lines no longer read as written. */
export function noteThread(note: Note, diff: DiffsPayload | undefined): CommentThread {
  const file = diff?.files.find(file => file.path === note.path)
  const outdated = !file || (note.code !== undefined && buildChatQuote(file, rangeOf(note))?.code !== note.code)
  return {
    rootId: note.id,
    path: note.path,
    side: note.side,
    line: note.line,
    startLine: note.startLine,
    startSide: note.startSide,
    outdated,
    pending: !note.sent,
    comments: [{ id: note.id, body: note.body, createdAt: note.createdAt, pending: !note.sent }],
  }
}

/** What a copy hands the agent: each note as its labelled diff excerpt, then the request. */
export function notesMarkdown(notes: Note[]): string {
  return notes.map(note => note.code === undefined
    ? `\`${note.label}\`\n\n${note.body}`
    : withQuotes(note.body, [{ label: note.label, code: note.code }])).join('\n\n---\n\n')
}

function unsupported(): never {
  throw new Error('Local notes have no replies, resolutions or reviews')
}

export function createLocalNotes(
  storage: Storage,
  currentDiff: () => Promise<DiffsPayload | undefined>,
  updateNotes: (key: string, change: NoteChange) => Promise<void>,
): ReviewsApi {
  async function keyOf() {
    const ref = (await currentDiff())?.ref
    if (ref?.kind !== 'local')
      throw new Error('The diff has not loaded yet')
    // One list per worktree root, shared by every page of that worktree.
    return `notes:${encodeURIComponent(ref.repo)}`
  }
  async function read(): Promise<Note[]> {
    const parsed = v.safeParse(v.array(NoteSchema), await storage.getItem(await keyOf()))
    return parsed.success ? parsed.output : []
  }
  async function update(change: NoteChange) {
    await updateNotes(await keyOf(), change)
  }

  return {
    async fetch() {
      const [notes, diff] = await Promise.all([read(), currentDiff()])
      return { threads: notes.map(note => noteThread(note, diff)), summaries: [] }
    },
    async addComment({ target, body }) {
      const file = (await currentDiff())?.files.find(file => file.path === target.path)
      const quote = file && buildChatQuote(file, rangeOf(target))
      await update({ kind: 'add', note: {
        ...target,
        body,
        label: quote?.label ?? `${target.path}:${target.line}`,
        code: quote?.code,
        createdAt: new Date().toISOString(),
      } })
    },
    editComment: (id, body) => update({ kind: 'edit', id, body }),
    deleteComment: id => update({ kind: 'delete', id }),
    /** Copies every unsent note, then marks them sent; a failed copy leaves them unsent. */
    async submitReview() {
      const unsent = (await read()).filter(note => !note.sent)
      if (!unsent.length)
        return
      await navigator.clipboard.writeText(notesMarkdown(unsent))
      await update({ kind: 'sent', ids: unsent.map(note => note.id) })
    },
    reply: unsupported,
    resolveThread: unsupported,
    discardPendingReview: unsupported,
  }
}

/** A local source with notes, kept in `storage` (the repo cache): the user is the only viewer and may always write. */
export function withLocalNotes(storage: Storage, source: DiffSource, updateNotes: (key: string, change: NoteChange) => Promise<void>): DiffSource {
  const cache = createCacheRepositories(storage)
  let latest: DiffsPayload | undefined
  return {
    ...source,
    fetch: async () => latest = await source.fetch(),
    viewer: async () => ({ login: 'local', canWrite: true }),
    // A cached diff installs without `fetch`; the cache then holds what the page shows.
    reviews: createLocalNotes(storage, async () => latest ?? (await cache.diffs.get(await source.key()))?.diff, updateNotes),
  }
}
