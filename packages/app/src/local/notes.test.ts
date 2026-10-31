import type { DiffsPayload, FileChange } from '@pulls.review/core/types'
import { createStorage } from 'unstorage'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNotesUpdater } from '../../../cli/src/daemon/notes'
import { createLocalNotes } from './notes'

function diffWith(patch: string): DiffsPayload {
  const file = {
    path: 'src/a.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    isBinary: false,
    sha: 'sha',
    hunks: [{ header: '@@ -1,2 +1,2 @@', oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, patch }],
  } satisfies FileChange
  return { ref: { kind: 'local', repo: '/work/tree', target: '' }, title: 'Working tree', files: [file] }
}

const target = { path: 'src/a.ts', side: 'additions', line: 2 } as const

function setup() {
  let diff = diffWith(' const a = 1\n-const b = 2\n+const b = 3')
  const writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const storage = createStorage()
  const updateNotes = createNotesUpdater(storage)
  const notes = createLocalNotes(storage, async () => diff, updateNotes)
  const anotherNotes = createLocalNotes(storage, async () => diff, updateNotes)
  return { notes, anotherNotes, writeText, setDiff: (patch: string) => diff = diffWith(patch) }
}

afterEach(() => vi.unstubAllGlobals())

describe('local notes', () => {
  it('preserves concurrent additions from two pages of the same worktree', async () => {
    const { notes, anotherNotes } = setup()
    await Promise.all([
      notes.addComment({ target, body: 'First page', mode: 'review', headSha: 'x' }),
      anotherNotes.addComment({ target, body: 'Second page', mode: 'review', headSha: 'x' }),
    ])

    const { threads } = await notes.fetch()
    expect(threads.map(thread => thread.comments[0]!.body)).toEqual(['First page', 'Second page'])
    expect(new Set(threads.map(thread => thread.rootId)).size).toBe(2)
  })

  it('copies unsent notes once, with their diff excerpt', async () => {
    const { notes, writeText } = setup()
    await notes.addComment({ target, body: 'Use a constant', mode: 'review', headSha: 'x' })

    await notes.submitReview('COMMENT', '')
    expect(writeText).toHaveBeenCalledWith('`src/a.ts:2`\n```diff\n+const b = 3\n```\n\nUse a constant')
    expect((await notes.fetch()).threads[0]).toMatchObject({ pending: false, outdated: false, line: 2 })

    await notes.submitReview('COMMENT', '')
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('keeps notes unsent when the copy fails', async () => {
    const { notes, writeText } = setup()
    await notes.addComment({ target, body: 'Rename', mode: 'review', headSha: 'x' })
    writeText.mockRejectedValueOnce(new Error('denied'))

    await expect(notes.submitReview('COMMENT', '')).rejects.toThrow('denied')
    expect((await notes.fetch()).threads[0]!.pending).toBe(true)
  })

  it('hides a note once its lines change', async () => {
    const { notes, setDiff } = setup()
    await notes.addComment({ target, body: 'Rename', mode: 'review', headSha: 'x' })

    setDiff(' const a = 1\n-const b = 2\n+const bb = 3')
    expect((await notes.fetch()).threads[0]!.outdated).toBe(true)
  })
})
