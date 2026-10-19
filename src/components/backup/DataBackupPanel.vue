<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useArchiveWorkspace } from '../../application/backup/useArchiveWorkspace'
import ArchiveImportPreview from './ArchiveImportPreview.vue'
import ArchiveSourceBar from './ArchiveSourceBar.vue'

const workspace = useArchiveWorkspace()
const { source, imported, selected, selectedSourceId, readOnly, ready, preview, busy, failure, notice } = workspace
const includeExportSecret = ref(false)
const includeSettingsSecret = ref(false)
const confirmRestore = ref(false)
const ownSavedCopy = computed(() => selected.value !== null && selected.value.source.id === source.value?.id)
const hasOwnSavedCopy = computed(() => imported.value.some((archive) => archive.source.id === source.value?.id))

watch(selectedSourceId, () => {
  includeSettingsSecret.value = false
  confirmRestore.value = false
})

async function chooseFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file !== undefined) await workspace.previewImport(file)
}
</script>

<template>
  <section class="backup-panel card" aria-labelledby="backup-heading" data-testid="data-backup-panel">
    <header>
      <h3 id="backup-heading">Data &amp; backup</h3>
      <p>Export complete history and saved settings, or open an archive from another browser. Bluetooth is not required.</p>
    </header>

    <ArchiveSourceBar :show-failure="false" />

    <fieldset :disabled="!ready || busy">
      <legend>Export</legend>
      <p>Downloads a compressed JSON archive (.json.gz) with retained raw samples, hourly summaries, important moments, warnings, device history and saved settings.</p>
      <p class="hint">Detailed samples stay on the browser that records them. Export this browser to back them up before its local allowance fills.</p>
      <label class="check">
        <input v-model="includeExportSecret" type="checkbox" data-testid="export-secret" />
        Include the Victron advertisement key
      </label>
      <p class="hint">The key lets someone read your controller's advertisements. Include it only in a backup you will keep private.</p>
      <div class="actions">
        <button type="button" data-testid="export-selected" @click="workspace.exportArchives(includeExportSecret, false)">
          {{ readOnly ? 'Export selected source' : 'Export this browser' }}
        </button>
        <button v-if="imported.length > 0" type="button" @click="workspace.exportArchives(includeExportSecret, true)">Export current sources</button>
      </div>
      <p v-if="hasOwnSavedCopy" class="hint">
        Current sources includes this browser's current history and other sources. Choose this
        browser's saved copy and use Export selected source to export that copy separately.
      </p>
    </fieldset>

    <fieldset :disabled="!ready || busy">
      <legend>Import</legend>
      <label class="file-picker">
        <span>Choose a Shunt JSON archive (.json.gz or .json)</span>
        <input type="file" accept=".json.gz,.json,application/gzip,application/json" @change="chooseFile" />
      </label>
      <ArchiveImportPreview v-if="preview.length > 0" :snapshots="preview" :imported="imported" />
      <div v-if="preview.length > 0" class="actions">
        <button type="button" data-testid="apply-import" @click="workspace.applyImport()">Import saved copies</button>
        <button type="button" @click="workspace.clearPreview()">Cancel import</button>
      </div>
    </fieldset>

    <fieldset v-if="selected" :disabled="busy">
      <legend>Settings from {{ selected.source.label }}</legend>
      <p>Apply this copy's saved preferences to this browser. Disconnect the radios first. Pairing permissions stay specific to each browser.</p>
      <label class="check">
        <input v-model="includeSettingsSecret" type="checkbox" data-testid="settings-secret" />
        Also apply its Victron advertisement key, if saved
      </label>
      <div class="actions">
        <button type="button" @click="workspace.applySelectedPreferences(includeSettingsSecret)">Apply saved settings</button>
      </div>
    </fieldset>

    <fieldset v-if="ownSavedCopy" :disabled="busy">
      <legend>Restore this browser's history</legend>
      <p>Replace this browser's complete history with the selected saved copy. All recordings must be stopped, and the saved copy must contain only closed sessions.</p>
      <p class="hint">A compact Drive copy contains hourly history. Restoring it also removes any detailed samples currently retained in this browser.</p>
      <label class="check">
        <input v-model="confirmRestore" type="checkbox" />
        Replace this browser's current history with this saved copy
      </label>
      <div class="actions">
        <button type="button" class="danger" :disabled="!confirmRestore" @click="workspace.restoreSelectedArchive()">Restore history</button>
      </div>
    </fieldset>

    <div v-if="busy" class="actions" role="status">
      <span>Working on the archive…</span>
      <button type="button" @click="workspace.cancel()">Cancel transfer</button>
    </div>
    <p v-if="!ready && !failure" role="status">Opening the archive…</p>
    <p v-if="failure" class="failure" role="alert">{{ failure }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.backup-panel { display: flex; flex-direction: column; gap: 1.25rem; padding: var(--pad); }
header { display: flex; flex-direction: column; gap: 0.5rem; }
h3, p { margin: 0; }
h3 { font-size: 1.05rem; }
p { max-width: 75ch; font-size: var(--text-copy); color: var(--ink-secondary); }
fieldset { display: flex; flex-direction: column; gap: 0.85rem; border: 0; border-top: 1px solid var(--gridline); padding: 1rem 0 0; margin: 0; min-width: 0; }
legend { padding: 0 0.5rem 0 0; font-weight: 600; }
.check { display: flex; align-items: flex-start; gap: 0.6rem; min-height: var(--tap); font-size: var(--text-copy); }
.check input { flex: none; margin-top: 0.25rem; }
.hint { font-size: 0.8rem; }
.actions { display: flex; flex-wrap: wrap; gap: 0.65rem; align-items: center; }
button { min-height: var(--tap); padding: 0.5rem 0.85rem; color: var(--ink); border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--raised); font: inherit; }
button:disabled, fieldset:disabled { opacity: 0.6; }
.file-picker { display: flex; flex-direction: column; gap: 0.5rem; font-size: var(--text-copy); }
.file-picker input { max-width: 100%; font: inherit; color: var(--ink-secondary); }
.file-picker input::file-selector-button { min-height: var(--tap); padding: 0.5rem 0.85rem; margin-right: 0.65rem; border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--raised); color: var(--ink); font: inherit; }
.failure, .danger { color: var(--status-critical-ink); }
</style>
