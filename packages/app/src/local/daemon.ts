import * as v from 'valibot'

const WorktreeSchema = v.object({ id: v.string(), path: v.string(), branch: v.optional(v.string()) })
export type DaemonWorktree = v.InferOutput<typeof WorktreeSchema>

/** This page's worktree id when the multi-repo daemon serves it under `/r/<id>/`. */
export function daemonWorktreeId(): string | undefined {
  return new URL(document.baseURI).pathname.match(/^\/r\/([^/]+)\/$/)?.[1]
}

export class DaemonRequestError extends Error {
  constructor(readonly status: number) {
    super(`Daemon request failed (${status})`)
  }
}

// Absolute paths: the daemon's API sits at the origin root, above this page's `<base>`.
async function request<T extends v.GenericSchema>(schema: T, url: string, method = 'GET', body?: unknown): Promise<v.InferOutput<T>> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok)
    throw new DaemonRequestError(response.status)
  return v.parse(schema, await response.json())
}

export const readRepos = () => request(v.array(v.object({ path: v.string() })), '/api/repos')
export const readWorktrees = (path: string) => request(v.array(WorktreeSchema), `/api/worktrees?path=${encodeURIComponent(path)}`)
export const addRepo = (path: string) => request(WorktreeSchema, '/api/repos', 'POST', { path })
export const removeRepo = (path: string) => request(v.object({ removed: v.literal(true) }), '/api/repos', 'DELETE', { path })
