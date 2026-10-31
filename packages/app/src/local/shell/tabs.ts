import * as v from 'valibot'

/** A review page under the daemon: `/r/<worktree id>/…`. */
const ReviewUrlSchema = v.pipe(v.string(), v.regex(/^\/r\/[\w-]+\//))

export const TabsSchema = v.object({
  tabs: v.array(v.object({ key: v.number(), url: ReviewUrlSchema })),
  active: v.optional(v.number()),
})
export type Tabs = v.InferOutput<typeof TabsSchema>

export const isReviewUrl = (url: string) => v.is(ReviewUrlSchema, url)
export const worktreeOf = (url: string) => url.match(/^\/r\/([\w-]+)\//)?.[1]

export function openTab(state: Tabs, url: string): Tabs {
  const key = Math.max(0, ...state.tabs.map(tab => tab.key)) + 1
  return { tabs: [...state.tabs, { key, url }], active: key }
}

/** Selects the worktree's first tab, or opens one at `url`. */
export function showWorktree(state: Tabs, url: string): Tabs {
  const id = worktreeOf(url)
  const tab = state.tabs.find(tab => worktreeOf(tab.url) === id)
  return tab ? { ...state, active: tab.key } : openTab(state, url)
}

/** Closing the active tab selects its right neighbour, else its left one. */
export function closeTab(state: Tabs, key: number): Tabs {
  const index = state.tabs.findIndex(tab => tab.key === key)
  const tabs = state.tabs.filter(tab => tab.key !== key)
  if (state.active !== key)
    return { ...state, tabs }
  return { tabs, active: (tabs[index] ?? tabs[index - 1])?.key }
}
