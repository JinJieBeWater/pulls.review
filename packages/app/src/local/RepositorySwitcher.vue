<!-- Fork-only: the local home's current-repository row; under the multi-repo daemon it also switches, adds and removes repositories. -->
<script setup lang="ts">
import type { DaemonWorktree } from './daemon'
import { daemonWorktreeId } from './daemon'
import { inShell, OPEN_WORKTREE_EVENT } from './shell/in-shell'
import WorktreeMenu from './WorktreeMenu.vue'

defineProps<{ root?: string }>()

const current = daemonWorktreeId()
const name = (path?: string) => path?.split('/').pop()

function open(tree: DaemonWorktree) {
  if (tree.id === current)
    return
  // In the shell this tab stays: the worktree gets its own.
  if (inShell)
    window.top!.dispatchEvent(new CustomEvent(OPEN_WORKTREE_EVENT, { detail: `/r/${tree.id}/` }))
  else
    location.assign(`/r/${tree.id}/`)
}

const row = 'h-9 w-full flex items-center gap-2 border border-base rounded bg-raised px-2 text-left text-sm'
</script>

<template>
  <WorktreeMenu v-if="current" :current="current" @pick="open">
    <button type="button" :class="row" class="outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary-500/40" :title="$t('local.repositories.switch')">
      <span class="i-ph:folder-duotone shrink-0 op-fade" aria-hidden="true" />
      <span class="shrink-0 font-mono">{{ name(root) }}</span>
      <span class="min-w-0 flex-1 truncate text-xs op-fade">{{ root }}</span>
      <span class="i-ph:caret-up-down shrink-0 op-fade" aria-hidden="true" />
    </button>
  </WorktreeMenu>
  <div v-else :class="row">
    <span class="i-ph:folder-duotone shrink-0 op-fade" aria-hidden="true" />
    <span class="shrink-0 font-mono">{{ name(root) }}</span>
    <span class="min-w-0 flex-1 truncate text-xs op-fade" :title="root">{{ root }}</span>
  </div>
</template>
