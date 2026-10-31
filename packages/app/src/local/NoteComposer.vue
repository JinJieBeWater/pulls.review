<script setup lang="ts">
import ActionButton from '@antfu/design/components/Action/ActionButton.vue'
import FormTextarea from '@antfu/design/components/Form/FormTextarea.vue'
import { ref } from 'vue'

// Upstream's `CommentComposer` layout with one action: notes are only ever collected.
defineProps<{
  busy?: boolean
  error?: string
}>()

const emit = defineEmits<{
  submit: [body: string]
  cancel: []
}>()

const body = ref('')

function submit() {
  if (body.value.trim())
    emit('submit', body.value)
}
</script>

<template>
  <div class="flex flex-col gap-2 p-2">
    <FormTextarea
      v-model="body"
      :rows="3"
      :placeholder="$t('local.notes.placeholder')"
      :disabled="busy"
      :invalid="!!error"
      @keydown.enter.meta="submit"
      @keydown.enter.ctrl="submit"
    />
    <p v-if="error" class="text-xs text-red-600 dark:text-red-400">
      {{ error }}
    </p>
    <div class="flex justify-end gap-2">
      <ActionButton size="sm" variant="text" :disabled="busy" @click="emit('cancel')">
        {{ $t('common.cancel') }}
      </ActionButton>
      <ActionButton size="sm" variant="primary" :loading="busy" :disabled="!body.trim()" @click="submit">
        {{ $t('local.notes.add') }}
      </ActionButton>
    </div>
  </div>
</template>
