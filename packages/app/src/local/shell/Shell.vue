<!-- Fork-only (plans/fork/02): the daemon's `/`, one tab per review, each an iframe at `/r/<id>/…`. It MUST NOT load the devframe client: frames would inherit its connection. -->
<script setup lang="ts">
import type { DaemonWorktree } from '../daemon'
import type { Tabs } from './tabs'
import ActionIconButton from '@antfu/design/components/Action/ActionIconButton.vue'
import FeedbackEmptyState from '@antfu/design/components/Feedback/FeedbackEmptyState.vue'
import { useEventListener, useLocalStorage, useTitle } from '@vueuse/core'
import { TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import * as v from 'valibot'
import { computed, nextTick, onMounted, onScopeDispose, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import DarkToggle from '../../components/DarkToggle.vue'
import LanguageMenu from '../../components/LanguageMenu.vue'
import { DaemonRequestError, readRepos, readWorktrees } from '../daemon'
import WorktreeMenu from '../WorktreeMenu.vue'
import { OPEN_SETTINGS_EVENT, OPEN_WORKTREE_EVENT } from './in-shell'
import { closeTab, isReviewUrl, openTab, showPage, showWorktree, TabsSchema, worktreeOf } from './tabs'

const state = useLocalStorage<Tabs>('pulls.review:tabs', { tabs: [] }, {
  serializer: {
    read: (raw) => {
      const parsed = v.safeParse(TabsSchema, JSON.parse(raw))
      return parsed.success ? parsed.output : { tabs: [] }
    },
    write: value => JSON.stringify(value),
  },
})
/** Where each frame started: changing `src` would reload it, so later navigation only updates `state`. */
const sources = reactive(new Map<number, string>())
const titles = reactive(new Map<number, string>())
const frames = new Map<number, Window>()
const worktrees = ref(new Map<string, { repo: string, tree: DaemonWorktree }>())
/** Worktrees with a commit not seen yet. */
const dots = reactive(new Set<string>())
const connection = ref<'online' | 'offline' | 'signed-out'>('online')
let events: EventSource | undefined
const { t } = useI18n()

/** The page this shell was opened at (`/r/<id>/…` from a launch or the address bar), before it follows the tabs. */
const requested = location.pathname + location.search
const active = computed(() => state.value.tabs.find(tab => tab.key === state.value.active))
useTitle(() => active.value ? `${titles.get(active.value.key) ?? label(active.value.url)} · pulls.review` : 'pulls.review')
// The address bar names the active tab's page, so it can be reloaded, bookmarked or shared.
watch(() => active.value?.url ?? '/', url => history.replaceState(null, '', url))

function select(key: number | undefined) {
  const tab = state.value.tabs.find(tab => tab.key === key)
  if (!tab)
    return
  state.value = { ...state.value, active: key }
  dots.delete(worktreeOf(tab.url)!)
}

function show(next: Tabs) {
  for (const tab of next.tabs) {
    if (!sources.has(tab.key))
      sources.set(tab.key, tab.url)
  }
  state.value = next
  select(next.active)
}

function pick(tree: DaemonWorktree) {
  show(openTab(state.value, `/r/${tree.id}/`))
  void loadWorktrees()
}

/** Shows a launched page in its worktree's tab, taking that tab there if it is elsewhere. */
function launch(url: string) {
  const next = showPage(state.value, url)
  const win = frames.get(next.active!)
  if (!win)
    sources.set(next.active!, url)
  else if (win.location.pathname + win.location.search !== url)
    win.location.assign(url)
  show(next)
}

async function onAppLaunch({ targetURL }: { targetURL?: string }) {
  if (!targetURL)
    return
  const url = new URL(targetURL)
  if (url.origin !== location.origin)
    return
  try {
    let page = url.pathname + url.search + url.hash
    if (url.pathname === '/login') {
      const response = await fetch(url.href, { headers: { Accept: 'application/json' } })
      if (!response.ok) {
        // A cold launch may already have exchanged the token through its initial navigation.
        await loadWorktrees()
        return
      }
      page = (await response.json()).path
    }
    if (typeof page === 'string' && isReviewUrl(page)) {
      launch(page)
      await loadWorktrees()
      if (!events && connection.value === 'online')
        listen()
    }
  }
  catch {
    connection.value = 'offline'
    void waitForDaemon()
  }
}

useEventListener(window, OPEN_WORKTREE_EVENT, (event) => {
  const url = (event as CustomEvent<unknown>).detail
  if (typeof url !== 'string' || !isReviewUrl(url))
    return
  show(showWorktree(state.value, url))
  // The tab's menu may have just added the worktree.
  void loadWorktrees()
})

function close(key: number) {
  sources.delete(key)
  titles.delete(key)
  frames.delete(key)
  show(closeTab(state.value, key))
}

/** Delete on a focused tab, the APG way to close a tab without its focusable close button. */
async function closeFromKeyboard(key: number) {
  close(key)
  await nextTick()
  document.querySelector<HTMLElement>('[role=tab][data-state=active]')?.focus()
}

function openSettings() {
  const win = frames.get(state.value.active!)
  // Focus follows into the frame, so Escape and the dialog's focus trap work.
  win?.focus()
  win?.dispatchEvent(new Event(OPEN_SETTINGS_EVENT))
}

function where(url: string) {
  const known = worktrees.value.get(worktreeOf(url)!)
  return known && { repo: known.repo.split('/').pop(), branch: known.tree.branch ?? known.tree.path.split('/').pop() }
}

function label(url: string) {
  const known = where(url)
  return known ? `${known.repo} · ${known.branch}` : worktreeOf(url)!
}

async function loadWorktrees() {
  try {
    const repos = await readRepos()
    const lists = await Promise.all(repos.map(repo => readWorktrees(repo.path).then(trees => trees.map(tree => [tree.id, { repo: repo.path, tree }] as const), () => [])))
    worktrees.value = new Map(lists.flat())
    connection.value = 'online'
  }
  catch (cause) {
    connection.value = cause instanceof DaemonRequestError && cause.status === 401 ? 'signed-out' : 'offline'
  }
}

// Down: wait for the daemon, then start over with fresh assets.
async function waitForDaemon() {
  while (connection.value === 'offline') {
    await new Promise(resolve => setTimeout(resolve, 3000))
    if (await fetch('/api/status').then(response => response.ok, () => false))
      location.reload()
  }
}

// --- New commits (the daemon's `/api/events`) ---

const notify = useLocalStorage('pulls.review:notify', false)
const permission = ref(typeof Notification === 'undefined' ? 'denied' : Notification.permission)
const notifyLabel = computed(() => t(permission.value === 'denied' ? 'local.shell.notifyBlocked' : notify.value ? 'local.shell.notifyOff' : 'local.shell.notify'))

async function toggleNotify() {
  if (notify.value) {
    notify.value = false
    return
  }
  permission.value = await Notification.requestPermission()
  notify.value = permission.value === 'granted'
}

const CommitSchema = v.object({ id: v.string(), repo: v.string(), branch: v.optional(v.string()), sha: v.string(), subject: v.string() })

function onCommit(raw: string) {
  const parsed = v.safeParse(CommitSchema, JSON.parse(raw))
  if (!parsed.success)
    return
  const commit = parsed.output
  const url = `/r/${commit.id}/`
  dots.add(commit.id)
  // Keep the dot, but avoid a system notification for the focused active tab.
  if (active.value && worktreeOf(active.value.url) === commit.id && document.hasFocus())
    return
  if (!notify.value || permission.value !== 'granted')
    return
  const where = `${commit.repo.split('/').pop()}${commit.branch ? ` · ${commit.branch}` : ''}`
  const notification = new Notification(where, { body: commit.subject, tag: commit.id, icon: '/favicon.svg' })
  notification.onclick = () => {
    window.focus()
    show(showWorktree(state.value, url))
    notification.close()
  }
}

function listen() {
  events = new EventSource('/api/events')
  events.onmessage = event => onCommit(event.data)
  // EventSource retries by itself; a daemon that went away gets the offline page instead.
  events.onerror = async () => {
    if (await fetch('/api/status').then(response => response.ok, () => false))
      return
    events?.close()
    connection.value = 'offline'
    void waitForDaemon()
  }
}
onScopeDispose(() => events?.close())

// --- Frames ---

const SUFFIX = ' · pulls.review'

/** Follows a frame's own navigation, and lets Cmd/Ctrl+1–9 work while it has focus. */
function attach(key: number, frame: HTMLIFrameElement) {
  const win = frame.contentWindow
  const doc = frame.contentDocument
  if (!win || !doc)
    return
  frames.set(key, win)
  const sync = () => {
    const url = win.location.pathname + win.location.search
    // Only the app's own titles: the page's static one shows until the app has loaded.
    if (doc.title.endsWith(SUFFIX))
      titles.set(key, doc.title.slice(0, -SUFFIX.length))
    if (isReviewUrl(url))
      state.value = { ...state.value, tabs: state.value.tabs.map(tab => tab.key === key ? { ...tab, url } : tab) }
  }
  sync()
  // An SPA navigation changes the title but fires no `load`.
  new MutationObserver(sync).observe(doc.head, { subtree: true, childList: true, characterData: true })
  win.addEventListener('keydown', onKey)
}

function onKey(event: KeyboardEvent) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || !/^[1-9]$/.test(event.key))
    return
  const tabs = state.value.tabs
  // Like browsers: 9 is the last tab.
  const tab = event.key === '9' ? tabs.at(-1) : tabs[Number(event.key) - 1]
  if (!tab)
    return
  event.preventDefault()
  select(tab.key)
}
useEventListener(window, 'keydown', onKey)

onMounted(async () => {
  for (const tab of state.value.tabs)
    sources.set(tab.key, tab.url)
  if (isReviewUrl(requested))
    launch(requested)
  else
    history.replaceState(null, '', active.value?.url ?? '/')
  if ('launchQueue' in window) {
    const queue = window.launchQueue as { setConsumer: (consumer: typeof onAppLaunch) => void }
    // LaunchQueue does not wait for async consumers; keep successive launches in order.
    let pending = Promise.resolve()
    queue.setConsumer(params => pending = pending.then(() => onAppLaunch(params)))
  }
  await loadWorktrees()
  if (!events && connection.value === 'online')
    listen()
  void waitForDaemon()
})

const model = computed({
  get: () => String(state.value.active ?? ''),
  set: value => select(Number(value)),
})
</script>

<template>
  <div class="h-screen flex flex-col bg-base color-base">
    <header class="h-11 flex shrink-0 items-center gap-3 border-b border-base px-3">
      <span class="shrink-0 font-mono">
        <span class="color-accent-magenta">+</span>pulls<span class="color-accent-orange">.</span><span class="color-accent-teal">review</span>
      </span>
      <TabsRoot v-if="connection === 'online' && state.tabs.length" v-model="model" class="min-w-0 flex self-stretch" activation-mode="manual">
        <TabsList class="h-full flex of-x-auto" :aria-label="$t('local.shell.tabs')">
          <div v-for="(tab, index) in state.tabs" :key="tab.key" class="group relative flex shrink-0 items-center">
            <TabsTrigger
              :value="String(tab.key)"
              class="h-full max-w-60 flex items-center gap-1.5 border-b-2 border-transparent rounded-t-md pl-3 pr-7 text-sm color-muted outline-none transition data-[state=active]:border-primary-500 hover:bg-hover data-[state=active]:color-active hover:color-base focus-visible:ring-2 focus-visible:ring-primary-500/40 focus-visible:ring-inset dark:data-[state=active]:border-primary-400"
              :title="`${label(tab.url)}: ${titles.get(tab.key) ?? tab.url}${index < 9 ? ` (⌘${index + 1})` : ''}`"
              @keydown.delete.prevent="closeFromKeyboard(tab.key)"
            >
              <span v-if="dots.has(worktreeOf(tab.url)!)" class="h-2 w-2 shrink-0 rounded-full bg-primary-500" :aria-label="$t('local.shell.newCommit')" />
              <span class="shrink-0 font-mono">{{ where(tab.url)?.repo ?? worktreeOf(tab.url) }}</span>
              <span v-if="where(tab.url)" class="min-w-0 truncate color-muted font-mono">{{ where(tab.url)!.branch }}</span>
            </TabsTrigger>
            <ActionIconButton
              compact
              icon="i-ph:x"
              :label="$t('local.shell.close')"
              tabindex="-1"
              class="absolute right-1 op0 group-hover:op100"
              :class="{ op60: tab.key === state.active }"
              @click="close(tab.key)"
            />
          </div>
        </TabsList>
      </TabsRoot>
      <WorktreeMenu v-if="connection === 'online'" wide :dots="dots" @pick="pick">
        <ActionIconButton compact icon="i-ph:plus" :label="$t('local.shell.open')" :tooltip="$t('local.shell.open')" />
      </WorktreeMenu>
      <div class="flex-1" />
      <div class="flex shrink-0 items-center gap-1">
        <ActionIconButton
          v-if="connection === 'online'"
          :icon="notify && permission === 'granted' ? 'i-ph:bell-ringing-duotone' : 'i-ph:bell-slash'"
          :label="notifyLabel"
          :tooltip="notifyLabel"
          :disabled="permission === 'denied'"
          @click="toggleNotify"
        />
        <ActionIconButton
          href="https://github.com/antfu/pulls.review"
          target="_blank"
          rel="noopener"
          icon="i-carbon-logo-github"
          :label="$t('common.githubRepository')"
          tooltip="GitHub"
        />
        <LanguageMenu />
        <ActionIconButton v-if="active" icon="i-ph:gear-duotone" :label="$t('common.settings')" :tooltip="$t('common.settings')" @click="openSettings" />
        <DarkToggle />
      </div>
    </header>

    <main class="relative min-h-0 flex-1">
      <FeedbackEmptyState v-if="connection === 'offline'" icon="i-ph:plugs-duotone" :title="$t('local.shell.offline')" class="h-full">
        <template #hint>
          <i18n-t keypath="local.shell.offlineHint" tag="span" scope="global">
            <template #command>
              <code class="rounded bg-code px-1 font-mono">pulls.review -d</code>
            </template>
          </i18n-t>
        </template>
      </FeedbackEmptyState>
      <FeedbackEmptyState v-else-if="connection === 'signed-out'" icon="i-ph:lock-key-duotone" :title="$t('local.shell.signedOut')" class="h-full">
        <template #hint>
          <i18n-t keypath="local.shell.signedOutHint" tag="span" scope="global">
            <template #command>
              <code class="rounded bg-code px-1 font-mono">pulls.review -d</code>
            </template>
          </i18n-t>
        </template>
      </FeedbackEmptyState>
      <template v-else>
        <FeedbackEmptyState v-if="!state.tabs.length" icon="i-ph:git-diff-duotone" :title="$t('local.shell.empty')" class="h-full">
          <template #hint>
            {{ $t('local.shell.emptyHint') }}
          </template>
        </FeedbackEmptyState>
        <iframe
          v-for="tab in state.tabs"
          :key="tab.key"
          :src="sources.get(tab.key) ?? tab.url"
          :title="label(tab.url)"
          allow="clipboard-write"
          class="absolute inset-0 h-full w-full border-0"
          :class="tab.key === state.active ? '' : 'invisible'"
          @load="attach(tab.key, $event.target as HTMLIFrameElement)"
        />
      </template>
    </main>
  </div>
</template>
