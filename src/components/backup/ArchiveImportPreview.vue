<script setup lang="ts">
import type { ArchiveSnapshot } from '../../domain/backup/ArchiveSnapshot'
import type { ImportedArchive } from '../../application/backup/ImportedArchive'
import { SECRET_PREFERENCE_KEY } from '../../domain/backup/archivePreferences'

defineProps<{
  snapshots: readonly ArchiveSnapshot[]
  imported: readonly ImportedArchive[]
}>()
</script>

<template>
  <section class="preview" aria-labelledby="import-preview-heading">
    <h4 id="import-preview-heading">Review import</h4>
    <article v-for="snapshot in snapshots" :key="snapshot.source.id" class="snapshot">
      <h5>{{ snapshot.source.label }}</h5>
      <p>Captured {{ new Date(snapshot.exportedAt).toLocaleString() }}</p>
      <dl>
        <div><dt>Sessions</dt><dd>{{ snapshot.stores.sessions.length.toLocaleString() }}</dd></div>
        <div><dt>Stored samples</dt><dd>{{ snapshot.stores.chunks.reduce((total, chunk) => total + chunk.length, 0).toLocaleString() }}</dd></div>
        <div><dt>Device history records</dt><dd>{{ snapshot.stores.ringRecords.length.toLocaleString() }}</dd></div>
        <div><dt>Saved settings</dt><dd>{{ snapshot.preferences.length }}</dd></div>
      </dl>
      <p v-if="imported.some((archive) => archive.source.id === snapshot.source.id)" class="replacement">
        This replaces the saved copy of this source, including its history and saved settings.
        Records from the two copies are not combined.
      </p>
      <p v-else>This source will be added as a separate read-only archive.</p>
      <p v-if="snapshot.preferences.some((preference) => preference.key === SECRET_PREFERENCE_KEY)">
        Contains a Victron advertisement key. It stays in the saved copy until you explicitly apply it.
      </p>
    </article>
    <p>Your current recordings and browser settings stay unchanged. Choose the imported source to browse its history.</p>
  </section>
</template>

<style scoped>
h4, h5, p { margin: 0; }
h4 { font-size: 1rem; }
h5 { font-size: 1rem; overflow-wrap: anywhere; }
p { color: var(--ink-secondary); font-size: var(--text-copy); }
.preview, .snapshot { display: flex; flex-direction: column; gap: 0.65rem; }
.snapshot { padding: 0.85rem; background: var(--raised); border: 1px solid var(--card-border); border-radius: var(--r-sm); }
dl { display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; margin: 0; }
dt { font-size: 0.75rem; color: var(--ink-secondary); }
dd { margin: 0.2rem 0 0; font-family: var(--font-mono); }
.replacement { color: var(--ink); font-weight: 600; }
</style>
