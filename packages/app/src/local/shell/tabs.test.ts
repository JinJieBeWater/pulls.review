import { describe, expect, it } from 'vitest'
import { closeTab, isReviewUrl, openTab, showWorktree } from './tabs'

describe('tabs', () => {
  it('selects a worktree\'s open tab instead of opening another', () => {
    let state = openTab({ tabs: [] }, '/r/a-1/commit/HEAD')
    state = openTab(state, '/r/b-2/')
    expect(showWorktree(state, '/r/a-1/').active).toBe(1)
    expect(showWorktree(state, '/r/c-3/').tabs.map(tab => tab.url)).toEqual(['/r/a-1/commit/HEAD', '/r/b-2/', '/r/c-3/'])
  })

  it('selects a neighbour when the active tab closes', () => {
    const state = ['/r/a-1/', '/r/b-2/', '/r/c-3/'].reduce(openTab, { tabs: [] })
    expect(closeTab({ ...state, active: 2 }, 2).active).toBe(3)
    expect(closeTab(state, 3).active).toBe(2)
    expect(closeTab({ ...state, active: 1 }, 3).active).toBe(1)
    expect(closeTab({ tabs: [{ key: 1, url: '/r/a-1/' }], active: 1 }, 1)).toEqual({ tabs: [], active: undefined })
  })

  it('only takes review pages', () => {
    expect(['/r/a-1/', '/r/a-1/commit/HEAD', '/', '/r/../x', 'https://evil.test/r/a/', '//evil.test/r/a/'].map(isReviewUrl))
      .toEqual([true, true, false, false, false, false])
  })
})
