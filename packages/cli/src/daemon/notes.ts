import type { NoteChange } from '@pulls.review/core/local-rpc'
import type { Storage } from 'unstorage'
import { NoteSchema } from '@pulls.review/core/local-rpc'
import * as v from 'valibot'

/** One queue in the worktree's server, shared by all its pages and windows. */
export function createNotesUpdater(storage: Storage) {
  let pending = Promise.resolve()
  return (key: string, change: NoteChange): Promise<void> => {
    const updated = pending.then(async () => {
      const parsed = v.safeParse(v.array(NoteSchema), await storage.getItem(key))
      let notes = parsed.success ? parsed.output : []
      switch (change.kind) {
        case 'add':
          notes.push({ ...change.note, id: Math.max(0, ...notes.map(note => note.id)) + 1, sent: false })
          break
        case 'edit':
          notes = notes.map(note => note.id === change.id ? { ...note, body: change.body } : note)
          break
        case 'delete':
          notes = notes.filter(note => note.id !== change.id)
          break
        case 'sent':
          notes = notes.map(note => change.ids.includes(note.id) ? { ...note, sent: true } : note)
          break
      }
      await storage.setItem(key, notes)
    })
    // Report this write's failure to its caller without blocking later writes.
    pending = updated.catch(() => {})
    return updated
  }
}
