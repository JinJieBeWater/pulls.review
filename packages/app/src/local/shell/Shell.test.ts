import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { i18n } from '../../i18n'
import Shell from './Shell.vue'

vi.mock('../daemon', async importOriginal => ({
  ...await importOriginal<typeof import('../daemon')>(),
  readRepos: vi.fn().mockResolvedValue([]),
}))

afterEach(() => {
  localStorage.clear()
  // The shell names its active page in the address bar, and reads it on mount.
  history.replaceState(null, '', '/')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function stubEvents() {
  const events = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    shows: [] as ((event: MessageEvent) => void)[],
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => void events.shows.push(listener),
    close: vi.fn(),
  }
  vi.stubGlobal('EventSource', vi.fn(class {
    constructor() {
      return events
    }
  }))
  return events
}

function mountShell() {
  return mount(Shell, {
    global: {
      plugins: [i18n],
      stubs: { ActionIconButton: true, DarkToggle: true, LanguageMenu: true, WorktreeMenu: true },
    },
  })
}

it('dots the focused active tab while suppressing its system notification', async () => {
  localStorage.setItem('pulls.review:tabs', JSON.stringify({ tabs: [{ key: 1, url: '/r/tree-1/' }], active: 1 }))
  localStorage.setItem('pulls.review:notify', 'true')
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const notification = Object.assign(vi.fn(), { permission: 'granted' })
  vi.stubGlobal('Notification', notification)
  const events = stubEvents()

  const wrapper = mountShell()
  try {
    await flushPromises()
    const tab = wrapper.get('[role="tab"][data-state="active"]')
    const dot = `[aria-label="${i18n.global.t('local.shell.newCommit')}"]`
    expect(tab.find(dot).exists()).toBe(false)
    const commit = { id: 'tree-1', repo: '/repo', sha: 'abc123', subject: 'New commit' }

    events.onmessage!(new MessageEvent('message', { data: JSON.stringify(commit) }))
    await nextTick()

    expect(tab.find(dot).exists()).toBe(true)
    expect(notification).not.toHaveBeenCalled()

    focus.mockReturnValue(false)
    events.onmessage!(new MessageEvent('message', { data: JSON.stringify(commit) }))
    expect(notification).toHaveBeenCalledOnce()
  }
  finally {
    wrapper.unmount()
  }
})

it('shows a launched page in its worktree\'s tab and names the active page in the address bar', async () => {
  localStorage.setItem('pulls.review:tabs', JSON.stringify({ tabs: [{ key: 1, url: '/r/tree-1/commit/abc' }, { key: 2, url: '/r/tree-2/' }], active: 2 }))
  const events = stubEvents()
  const wrapper = mountShell()
  try {
    await flushPromises()
    expect(location.pathname).toBe('/r/tree-2/')
    events.shows[0]!(new MessageEvent('show', { data: JSON.stringify('/r/tree-1/worktree') }))
    await nextTick()
    expect(wrapper.findAll('iframe').map(frame => frame.attributes('src'))).toEqual(['/r/tree-1/worktree', '/r/tree-2/'])
    expect(location.pathname).toBe('/r/tree-1/worktree')
  }
  finally {
    wrapper.unmount()
  }
})
