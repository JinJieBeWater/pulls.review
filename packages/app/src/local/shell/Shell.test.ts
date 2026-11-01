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

it('opens the addressed page in its worktree\'s tab instead of its old page', async () => {
  localStorage.setItem('pulls.review:tabs', JSON.stringify({ tabs: [{ key: 1, url: '/r/tree-1/commit/abc' }, { key: 2, url: '/r/tree-2/' }], active: 2 }))
  history.replaceState(null, '', '/r/tree-1/worktree')
  stubEvents()
  const wrapper = mountShell()
  try {
    await flushPromises()
    expect(wrapper.findAll('iframe').map(frame => frame.attributes('src'))).toEqual(['/r/tree-1/worktree', '/r/tree-2/'])
    expect(location.pathname).toBe('/r/tree-1/worktree')
  }
  finally {
    wrapper.unmount()
  }
})

it('handles PWA launches in the existing shell without adding a second tab for the worktree', async () => {
  localStorage.setItem('pulls.review:tabs', JSON.stringify({ tabs: [{ key: 1, url: '/r/tree-1/commit/abc' }], active: 1 }))
  stubEvents()
  const queue = { setConsumer: vi.fn() }
  vi.stubGlobal('launchQueue', queue)
  const fetch = vi.fn().mockResolvedValue(Response.json({ path: '/r/tree-1/worktree' }))
  vi.stubGlobal('fetch', fetch)
  const wrapper = mountShell()
  try {
    await flushPromises()
    expect(queue.setConsumer).toHaveBeenCalledOnce()
    const consume = queue.setConsumer.mock.calls[0][0]
    await consume({ targetURL: `${location.origin}/login?token=one-time` })
    await nextTick()
    expect(fetch).toHaveBeenCalledWith(`${location.origin}/login?token=one-time`, { headers: { Accept: 'application/json' } })
    expect(wrapper.findAll('iframe').map(frame => frame.attributes('src'))).toEqual(['/r/tree-1/worktree'])
    expect(location.pathname).toBe('/r/tree-1/worktree')
    await consume({ targetURL: `${location.origin}/r/tree-1/worktree` })
    await nextTick()
    expect(wrapper.findAll('iframe')).toHaveLength(1)
    await consume({ targetURL: 'https://evil.test/login?token=anything' })
    expect(fetch).toHaveBeenCalledOnce()
    // On a cold launch the initial redirect can have used the token before the queue delivers it.
    fetch.mockResolvedValueOnce(new Response(null, { status: 401 }))
    await consume({ targetURL: `${location.origin}/login?token=already-used` })
    await nextTick()
    expect(location.pathname).toBe('/r/tree-1/worktree')
    expect(wrapper.findAll('iframe')).toHaveLength(1)
  }
  finally {
    wrapper.unmount()
  }
})

it('keeps the last PWA target when two launches arrive before sign-in finishes', async () => {
  stubEvents()
  const queue = { setConsumer: vi.fn() }
  vi.stubGlobal('launchQueue', queue)
  let release!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(resolve => release = resolve))
    .mockResolvedValueOnce(Response.json({ path: '/r/tree-1/worktree' })))
  const wrapper = mountShell()
  try {
    await flushPromises()
    const consume = queue.setConsumer.mock.calls[0][0]
    const first = consume({ targetURL: `${location.origin}/login?token=first` })
    const last = consume({ targetURL: `${location.origin}/login?token=last` })
    await flushPromises()
    release(Response.json({ path: '/r/tree-1/commit/old' }))
    await Promise.all([first, last])
    await nextTick()
    expect(location.pathname).toBe('/r/tree-1/worktree')
    expect(wrapper.findAll('iframe')).toHaveLength(1)
  }
  finally {
    wrapper.unmount()
  }
})
