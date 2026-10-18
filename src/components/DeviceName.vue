<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useArchiveWorkspace } from '../application/backup/useArchiveWorkspace'

const { readOnly } = useArchiveWorkspace()

const props = defineProps<{
  label: string
  defaultLabel: string
  noun?: 'pack' | 'controller'
}>()

const emit = defineEmits<{ rename: [string | null] }>()

const editing = ref(false)
const draft = ref('')
const field = ref<HTMLInputElement | null>(null)
// Escape moves focus and triggers blur, so cancellation must suppress that save.
let cancelled = false

watch(readOnly, () => cancel())

async function begin(): Promise<void> {
  if (readOnly.value) return
  // An unrenamed device opens empty rather than pre-filled with the default, so accepting the
  // default is Escape and adopting it as a user label is a deliberate retype.
  draft.value = props.label === props.defaultLabel ? '' : props.label
  cancelled = false
  editing.value = true
  await nextTick()
  field.value?.focus()
  field.value?.select()
}

function commit(): void {
  if (readOnly.value || !editing.value || cancelled) return
  editing.value = false
  const chosen = draft.value.trim()
  emit('rename', chosen === '' ? null : chosen)
}

function cancel(): void {
  cancelled = true
  editing.value = false
}
</script>

<template>
  <button v-if="!readOnly && !editing" type="button" class="rename" @click="begin()">Rename</button>

  <form v-else-if="!readOnly" class="editor" @submit.prevent="commit()">
    <input
      ref="field"
      v-model="draft"
      type="text"
      class="field"
      :placeholder="defaultLabel"
      :aria-label="`Name for ${defaultLabel}`"
      autocomplete="off"
      spellcheck="false"
      @keydown.esc.prevent="cancel()"
      @blur="commit()"
    />
    <button type="submit" class="action">Save</button>
    <button type="button" class="action" @mousedown.prevent @click="cancel()">Cancel</button>

    <p class="copy hint">
      This {{ noun ?? 'pack' }} keeps its name across sessions and in exported archives.
      <br />
      Clear the field to go back to {{ defaultLabel }}.
    </p>
  </form>
</template>

<style scoped>
.rename,
.action {
  background: transparent;
  border: 1px solid var(--card-border);
  color: var(--ink-secondary);
  border-radius: var(--r-sm);
  padding: 0.25rem 0.7rem;
  min-height: var(--tap);
  display: inline-flex;
  align-items: center;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.rename:hover,
.action:hover {
  color: var(--ink);
  border-color: var(--baseline);
}

.editor {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.field {
  flex: 1 1 14rem;
  min-width: 0;
  min-height: var(--tap);
  background: var(--plane);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 1rem;
  padding: 0.3rem 0.6rem;
}

.hint {
  flex-basis: 100%;
  margin: 0;
  color: var(--ink-muted);
}
</style>
