<script setup lang="ts">
import type { CommentThread } from '@pulls.review/core/types'
import type { DiffsStoreReviews } from '../stores/types'
import ActionButton from '@antfu/design/components/Action/ActionButton.vue'
import ActionIconButton from '@antfu/design/components/Action/ActionIconButton.vue'
import DisplayBadge from '@antfu/design/components/Display/DisplayBadge.vue'
import DisplayDate from '@antfu/design/components/Display/DisplayDate.vue'
import FormTextarea from '@antfu/design/components/Form/FormTextarea.vue'
import { Markdown } from '@comark/vue'
import { computed, ref } from 'vue'

// Upstream's `ReviewThreadCard` + `ReviewCommentCard` layout, without the author and replies.
const props = defineProps<{
  thread: CommentThread
  reviews: DiffsStoreReviews
}>()

const note = computed(() => props.thread.comments[0]!)
const busy = ref(false)
const error = ref<string>()
const editing = ref(false)
const draft = ref('')

async function run(action: () => Promise<void>) {
  busy.value = true
  error.value = undefined
  try {
    await action()
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    busy.value = false
  }
}

function startEditing() {
  draft.value = note.value.body
  editing.value = true
}

function saveEdit() {
  if (!draft.value.trim())
    return
  void run(async () => {
    await props.reviews.editComment(note.value.id, draft.value)
    editing.value = false
  })
}
</script>

<template>
  <div class="my-1 max-w-200 overflow-hidden border border-base rounded-lg bg-base text-left font-sans">
    <article class="flex flex-col gap-1.5 px-3 py-2 text-sm">
      <header class="flex items-center gap-2">
        <DisplayDate :date="note.createdAt" class="text-xs op-fade" />
        <DisplayBadge v-if="thread.pending" :text="$t('review.pending')" class="text-xs text-amber-700 dark:text-amber-400" />
        <div class="flex-auto" />
        <template v-if="!editing">
          <ActionIconButton compact icon="i-ph:pencil-simple-duotone" :label="$t('review.editComment')" :disabled="busy" @click="startEditing" />
          <ActionIconButton compact icon="i-ph:trash-duotone" :label="$t('review.deleteComment')" :disabled="busy" @click="run(() => reviews.deleteComment(note.id))" />
        </template>
      </header>
      <div v-if="editing" class="flex flex-col gap-2">
        <FormTextarea v-model="draft" :rows="3" :disabled="busy" @keydown.enter.meta="saveEdit" @keydown.enter.ctrl="saveEdit" />
        <div class="flex justify-end gap-2">
          <ActionButton size="sm" variant="text" :disabled="busy" @click="editing = false">
            {{ $t('common.cancel') }}
          </ActionButton>
          <ActionButton size="sm" variant="primary" :disabled="busy || !draft.trim()" @click="saveEdit">
            {{ $t('common.save') }}
          </ActionButton>
        </div>
      </div>
      <Suspense v-else>
        <Markdown :value="note.body" class="review-comment-markdown text-sm" />
      </Suspense>
    </article>
    <p v-if="error" class="px-3 pb-1 text-xs text-red-600 dark:text-red-400">
      {{ error }}
    </p>
  </div>
</template>
