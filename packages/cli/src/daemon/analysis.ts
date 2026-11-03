import type { DiffCache } from '@pulls.review/core/cache'
import type { DiffsPayload } from '@pulls.review/core/types'
import type { WorktreeAnalyze } from './schema'
import { resolveDefaultBranch } from '@pulls.review/core/local'
import { LOCAL_RPC } from '@pulls.review/core/local-rpc'

/** A worktree server's own registered RPC functions, called in process. */
export type LocalCall = (name: string, args: unknown) => Promise<any>

/** The git target a review page shows, as the app's `targetFor` (`app/src/local/pages.ts`) picks it; other pages have none. */
export async function targetForPage(cwd: string, page: string): Promise<string | undefined> {
  const [, kind, ...rest] = page.split('/')
  const value = decodeURIComponent(rest.join('/'))
  if (kind === 'worktree')
    return ''
  if ((kind === 'compare' || kind === 'commit') && value)
    return value
  if (kind === 'branch' && value) {
    const base = await resolveDefaultBranch(cwd)
    return base && `${base.ref}...${value}`
  }
  return undefined
}

/**
 * `--analyze` without a page (plans/fork/03): starts the analysis a page would, keyed the same,
 * so a page finds and follows it. Keeps a running run and a result made for the current head.
 */
export async function analyzePage(call: LocalCall, diffs: DiffCache, cwd: string, { page, agent, model, locale, force }: WorktreeAnalyze): Promise<void> {
  const target = await targetForPage(cwd, page)
  if (target === undefined)
    return
  const key: string = await call(LOCAL_RPC.sourceKey, { target })
  if ((await call(LOCAL_RPC.agentRunning, { key })).streamId)
    return
  const diff: DiffsPayload = await call(LOCAL_RPC.sourceFetch, { target })
  const head = diff.head?.sha ?? ''
  const cached = await diffs.get(key)
  if (!force && cached?.analyzedBy.llm && cached.analyzedBy.llm.headSha === diff.head?.sha)
    return
  // The run saves its result onto the cache entry: there must be one, for the diff it analyzes.
  if (cached?.headSha !== head)
    await diffs.putDiff(key, diff, head)
  await call(LOCAL_RPC.agentAnalyze, { agent, model, diff, locale, key })
}
