<script setup lang="ts">
import type { DiffsStoreReviews } from '../stores/types'
import ActionButton from '@antfu/design/components/Action/ActionButton.vue'
import { ref } from 'vue'

const props = defineProps<{
  reviews: DiffsStoreReviews
}>()

const busy = ref(false)
const copied = ref(false)
const error = ref<string>()

async function copy() {
  busy.value = true
  error.value = undefined
  try {
    // Copying is the notes' `submitReview` (see `notes.ts`).
    await props.reviews.submitReview('COMMENT', '')
    copied.value = true
    setTimeout(() => copied.value = false, 2000)
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <span v-if="reviews.pendingCommentCount > 0 || copied" class="flex shrink-0 items-center gap-2">
    <span v-if="error" class="text-xs text-red-500">{{ error }}</span>
    <ActionButton
      size="sm"
      variant="action"
      :icon="copied ? 'i-ph:check-duotone' : 'i-ph:copy-duotone'"
      :loading="busy"
      @click="copy"
    >
      {{ copied ? $t('local.notes.copied') : $t('local.notes.copy', { n: reviews.pendingCommentCount }, reviews.pendingCommentCount) }}
    </ActionButton>
  </span>
</template>
