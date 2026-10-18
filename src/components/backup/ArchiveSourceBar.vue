<script setup lang="ts">
import { useArchiveWorkspace } from '../../application/backup/useArchiveWorkspace'

withDefaults(defineProps<{ showFailure?: boolean }>(), { showFailure: true })

const workspace = useArchiveWorkspace()
const { source, imported, selectedSourceId, selected, busy, ready, failure } = workspace

function selectSource(event: Event): void {
  const picker = event.target as HTMLSelectElement
  const selectedId = picker.value
  picker.value = selectedSourceId.value ?? ''
  void workspace.selectSource(selectedId === '' ? null : selectedId)
}
</script>

<template>
  <section v-if="ready" class="source-bar" aria-label="History source">
    <label class="source-picker">
      <span>History source</span>
      <select :value="selectedSourceId ?? ''" :disabled="busy" @change="selectSource">
        <option value="">This browser · {{ source?.label }}</option>
        <option v-for="archive in imported" :key="archive.source.id" :value="archive.source.id">
          {{ archive.source.label }} · saved copy
        </option>
      </select>
    </label>
    <p v-if="selected" class="source-note" role="status">
      Read-only copy captured {{ new Date(selected.exportedAt).toLocaleString() }}.
      Sessions marked open were recording at capture. Current recordings stay in this browser's archive.
    </p>
    <p v-else class="source-note">History recorded in this browser. Imported sources are kept separately.</p>
    <p v-if="showFailure && failure" class="source-note failure" role="alert">{{ failure }}</p>
  </section>
</template>

<style scoped>
.source-bar { padding: 1rem var(--pad); border-bottom: 1px solid var(--gridline); }
.source-picker { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; font-size: var(--text-copy); }
select { min-width: 0; max-width: 100%; min-height: var(--tap); padding: 0.4rem 0.6rem; color: var(--ink); background: var(--raised); border: 1px solid var(--card-border); border-radius: var(--r-sm); font: inherit; }
.source-note { margin: 0.5rem 0 0; max-width: 75ch; color: var(--ink-secondary); font-size: var(--text-copy); }
.failure { color: var(--status-critical-ink); }
</style>
