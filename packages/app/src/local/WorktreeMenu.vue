<!-- Fork-only: every registered repository's worktrees, searchable, with add and remove; the trigger is the slot. -->
<script setup lang="ts">
import type { DaemonWorktree } from './daemon'
import ActionButton from '@antfu/design/components/Action/ActionButton.vue'
import FormTextInput from '@antfu/design/components/Form/FormTextInput.vue'
import OverlayModal from '@antfu/design/components/Overlay/OverlayModal.vue'
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { addRepo, DaemonRequestError, readRepos, readWorktrees, removeRepo } from './daemon'

const props = defineProps<{
  /** The open worktree: marked, and its repository can't be removed. */
  current?: string
  /** Fixed width instead of the trigger's. */
  wide?: boolean
}>()

const emit = defineEmits<{
  pick: [tree: DaemonWorktree]
}>()

const { t } = useI18n()
const repos = ref<{ path: string, trees?: DaemonWorktree[] }[]>()
const loadError = ref('')

function failure(cause: unknown) {
  const status = cause instanceof DaemonRequestError ? cause.status : 0
  return t(status === 401 ? 'local.repositories.failure' : status === 400 ? 'local.repositories.invalidPath' : 'local.repositories.requestFailed')
}

async function load() {
  try {
    // One unavailable registration must not hide the others.
    repos.value = await Promise.all((await readRepos()).map(async ({ path }) => ({ path, trees: await readWorktrees(path).catch(() => undefined) })))
    loadError.value = ''
  }
  catch (cause) {
    loadError.value = failure(cause)
  }
}

const menu = ref(false)
const query = ref('')
// Read on every open: agents add and remove worktrees all the time.
watch(menu, (open) => {
  query.value = ''
  if (open)
    void load()
})

/** A repository matching by path keeps all its worktrees; otherwise only the worktrees matching by branch or path. */
const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  const hit = (...texts: (string | undefined)[]) => texts.some(text => text?.toLowerCase().includes(q))
  return (repos.value ?? [])
    .map(repo => hit(repo.path) ? repo : { ...repo, trees: repo.trees?.filter(tree => hit(tree.branch, tree.path)) })
    .filter(repo => hit(repo.path) || repo.trees?.length)
})
/** Removing the open repository would strand this page, so it offers no remove button. */
const isOpen = (repo: { trees?: DaemonWorktree[] }) => repo.trees?.some(tree => tree.id === props.current)
const name = (path?: string) => path?.split('/').pop()

function pick(tree: DaemonWorktree) {
  menu.value = false
  emit('pick', tree)
}

async function remove(path: string) {
  try {
    await removeRepo(path)
    await load()
  }
  catch (cause) {
    loadError.value = failure(cause)
  }
}

const adding = ref(false)
const path = ref('')
const busy = ref(false)
const addError = ref('')

function startAdding() {
  menu.value = false
  adding.value = true
}

async function add() {
  busy.value = true
  addError.value = ''
  try {
    const tree = await addRepo(path.value.trim())
    adding.value = false
    path.value = ''
    pick(tree)
  }
  catch (cause) {
    addError.value = failure(cause)
  }
  finally {
    busy.value = false
  }
}

const status = 'px-3 py-4 text-center text-sm op-mute'
</script>

<template>
  <PopoverRoot v-model:open="menu">
    <PopoverTrigger as-child>
      <slot />
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        align="start"
        :side-offset="6"
        :collision-padding="8"
        class="z-dropdown max-h-[min(28rem,var(--reka-popover-content-available-height))] flex flex-col overflow-hidden border border-base rounded-lg bg-base shadow-lg outline-none"
        :class="wide ? 'w-md max-w-[calc(100vw-1rem)]' : 'w-[--reka-popover-trigger-width]'"
      >
        <div class="p-1.5">
          <FormTextInput
            v-model="query"
            size="sm"
            icon="i-ph:magnifying-glass"
            :placeholder="$t('local.repositories.search')"
            clearable
            class="w-full"
          />
        </div>
        <div class="min-h-0 flex-1 of-y-auto pb-1">
          <div v-if="loadError" :class="status" role="alert">
            {{ loadError }}
          </div>
          <div v-else-if="!repos" :class="status">
            {{ $t('local.repositories.loading') }}
          </div>
          <div v-else-if="!shown.length" :class="status">
            {{ $t('local.repositories.noMatch') }}
          </div>
          <section v-for="repo in shown" :key="repo.path" :aria-label="name(repo.path)">
            <div class="group flex items-center gap-2 px-3 pb-1 pt-2 text-xs" :title="repo.path">
              <span class="i-ph:folder-duotone shrink-0 op-fade" aria-hidden="true" />
              <span class="shrink-0 font-medium font-mono">{{ name(repo.path) }}</span>
              <span class="min-w-0 flex-1 truncate op-mute">{{ repo.path }}</span>
              <button
                v-if="!isOpen(repo)"
                type="button"
                class="shrink-0 rounded p-0.5 op0 outline-none transition hover:text-red-600 focus-visible:op100 group-hover:op100 dark:hover:text-red-400"
                :title="$t('local.repositories.remove')"
                :aria-label="`${$t('local.repositories.remove')}: ${repo.path}`"
                @click="remove(repo.path)"
              >
                <span class="i-ph:trash block" aria-hidden="true" />
              </button>
            </div>
            <div v-if="!repo.trees" class="flex items-center gap-2 px-3 py-1.5 text-sm op-mute">
              <span class="i-ph:warning-duotone shrink-0" aria-hidden="true" />
              {{ $t('local.repositories.requestFailed') }}
            </div>
            <button
              v-for="tree in repo.trees"
              :key="tree.id"
              type="button"
              class="w-full flex items-center gap-2 py-1.5 pl-8 pr-3 text-left text-sm outline-none transition focus-visible:bg-hover"
              :class="tree.id === current ? 'color-active bg-active' : 'hover:bg-hover'"
              :aria-current="tree.id === current || undefined"
              :title="tree.path"
              @click="pick(tree)"
            >
              <span class="i-ph:git-branch-duotone shrink-0 op-fade" aria-hidden="true" />
              <span class="shrink-0 font-mono">{{ tree.branch ?? $t('local.repositories.detached') }}</span>
              <!-- The main worktree sits at the repository path its header already shows. -->
              <span class="min-w-0 flex-1 truncate text-xs op-mute">{{ tree.path === repo.path ? '' : tree.path }}</span>
              <span v-if="tree.id === current" class="i-ph:check shrink-0 text-xs" aria-hidden="true" />
            </button>
          </section>
        </div>
        <div class="border-t border-base p-1">
          <button type="button" class="w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm outline-none transition focus-visible:bg-hover hover:bg-hover" @click="startAdding">
            <span class="i-ph:plus shrink-0 op-fade" aria-hidden="true" />
            {{ $t('local.repositories.add') }}
          </button>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>

  <OverlayModal v-model:open="adding" :title="$t('local.repositories.add')">
    <form class="flex gap-2" @submit.prevent="add">
      <FormTextInput v-model="path" icon="i-ph:folder-duotone" :placeholder="$t('local.repositories.path')" class="flex-1" />
      <ActionButton type="submit" variant="primary" icon="i-ph:plus" :loading="busy" :disabled="!path.trim()">
        {{ $t('local.repositories.add') }}
      </ActionButton>
    </form>
    <p v-if="addError" class="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">
      {{ addError }}
    </p>
  </OverlayModal>
</template>
