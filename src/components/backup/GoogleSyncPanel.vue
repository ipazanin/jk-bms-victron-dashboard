<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useGoogleSync } from '../../application/sync/useGoogleSync'

const sync = useGoogleSync()
const {
  enabled, configured, prepared, preparing, connected, workspace, workspaces, revisions,
  sourceLabel, includeSecret, autoSync, busy, progress, failure, notice, lastSyncAt,
  conflicts, conflictReason,
} = sync
const workspaceName = ref('Shunt history')
const labelDraft = ref(sourceLabel.value)
const deletionName = ref('')
const mayDelete = computed(() => workspace.value !== null && deletionName.value === workspace.value.name)
const newestRevisions = computed(() => [...revisions.value].reverse())
const legacyWorkspace = computed(() => workspace.value !== null && workspace.value.version !== 2)

watch(sourceLabel, (label) => { labelDraft.value = label })
watch(workspace, () => { deletionName.value = '' })

function chooseListedWorkspace(event: Event): void {
  const picker = event.target as HTMLSelectElement
  const workspaceId = picker.value
  picker.value = workspace.value?.id ?? ''
  if (workspaceId !== '') void sync.selectWorkspace(workspaceId)
}

function deviceLabel(sourceId: string): string {
  return revisions.value.find((revision) => revision.source.id === sourceId)?.source.label ?? 'Another device'
}
</script>

<template>
  <section class="sync-panel card" aria-labelledby="google-sync-heading" data-testid="google-sync-panel">
    <header>
      <h3 id="google-sync-heading">Google sync</h3>
      <p>Keep hourly history and selected moments in Google Drive and share settings through a Google Sheet. Raw recordings stay in this browser. Cloud and archive access also work in Firefox without Bluetooth.</p>
    </header>

    <label class="check">
      <input :checked="enabled" type="checkbox" data-testid="enable-google-sync" @change="sync.setEnabled(($event.target as HTMLInputElement).checked)" />
      Enable Google sync for this browser
    </label>
    <p v-if="!enabled" class="hint">Optional and off by default. Turning sync off keeps existing cloud copies and local history.</p>

    <template v-if="enabled">
      <p v-if="!configured" role="status">
        Google sync is not configured for this installation. Its owner must add the Google OAuth client and Picker configuration before connecting. Local recording and JSON archives remain available.
      </p>
      <template v-else>
        <div class="actions">
          <template v-if="!connected">
            <button type="button" :disabled="!prepared || preparing || busy" data-testid="connect-google" @click="sync.connect()">Connect Google</button>
            <span v-if="preparing" role="status">Preparing Google sign-in…</span>
            <span v-else role="status">Google is disconnected.</span>
            <button v-if="!prepared && !preparing && failure" type="button" :disabled="busy" @click="sync.prepare()">Retry Google setup</button>
          </template>
          <template v-else>
            <span role="status">Google is connected for this browser session.</span>
            <button type="button" :disabled="busy" @click="sync.disconnect()">Disconnect Google</button>
          </template>
        </div>
        <p class="hint">Connect opens Google's account and permission window. If authorization expires, connect again to resume sync.</p>

        <template v-if="connected">
          <fieldset :disabled="busy">
            <legend>Sync workspace</legend>
            <p v-if="workspace">Using <strong>{{ workspace.name }}</strong>. Each browser keeps its own history source in this workspace.</p>
            <p v-else>Create a workspace, or choose the existing one used by your other devices.</p>
            <p v-if="legacyWorkspace" role="status">This legacy workspace is read-only. You can open its saved copies here. Create a compact workspace for new uploads, then check the new copies before removing the old workspace.</p>
            <label v-if="workspaces.length > 0" class="field">
              <span>Available workspaces</span>
              <select :value="workspace?.id ?? ''" @change="chooseListedWorkspace">
                <option value="" disabled>Choose a workspace</option>
                <option v-for="available in workspaces" :key="available.id" :value="available.id">{{ available.name }}</option>
              </select>
            </label>
            <div class="actions">
              <button type="button" @click="sync.chooseWorkspace()">Choose in Google Drive</button>
            </div>
            <details>
              <summary>Create a compact workspace</summary>
              <form class="create-workspace" @submit.prevent="sync.createWorkspace(workspaceName.trim())">
                <label class="field">
                  <span>Workspace name</span>
                  <input v-model="workspaceName" type="text" maxlength="120" required />
                </label>
                <button type="submit" :disabled="workspaceName.trim() === ''">Create workspace</button>
              </form>
            </details>
          </fieldset>

          <fieldset v-if="workspace && !legacyWorkspace" :disabled="busy">
            <legend>This browser</legend>
            <form class="label-form" @submit.prevent="sync.setSourceLabel(labelDraft.trim())">
              <label class="field">
                <span>Device label in the cloud</span>
                <input v-model="labelDraft" type="text" maxlength="100" placeholder="e.g. Boat tablet" required data-testid="cloud-device-label" />
              </label>
              <button type="submit" :disabled="labelDraft.trim() === '' || labelDraft.trim() === sourceLabel">Save label</button>
            </form>
            <label class="check">
              <input :checked="includeSecret" type="checkbox" data-testid="sync-secret" @change="sync.setIncludeSecret(($event.target as HTMLInputElement).checked)" />
              Include the Victron advertisement key in Google sync
            </label>
            <p class="hint">The key lets someone read your controller's advertisements. Anyone with access to this workspace could read a saved key. Turning this off does not remove keys from older cloud copies.</p>
            <label class="check">
              <input :checked="autoSync" type="checkbox" data-testid="automatic-sync" @change="sync.setAutoSync(($event.target as HTMLInputElement).checked)" />
              Sync automatically while this page is open and visible
            </label>
            <p class="hint">Theme, sidebar and Stats preferences are shared. Bluetooth permissions stay in each browser. Remembered readings and device logbooks stay with their history source.</p>
            <p class="hint">Settings and other devices are checked every minute. This browser uploads hourly while recording, when recording ends, or when you choose Sync now.</p>
            <div class="actions">
              <button type="button" data-testid="sync-now" @click="sync.syncNow()">Sync now</button>
              <span v-if="lastSyncAt !== null">Last synced {{ new Date(lastSyncAt).toLocaleString() }}</span>
              <span v-else>No completed sync yet.</span>
            </div>
          </fieldset>

          <fieldset v-if="conflicts.length > 0 && !legacyWorkspace" :disabled="busy" class="conflict">
            <legend>Choose shared settings</legend>
            <p role="alert">{{ conflictReason ?? 'Settings changed on more than one device. Choose which settings to share.' }}</p>
            <p>This choice applies to settings only. Disconnect the radios before applying cloud settings.</p>
            <div class="actions">
              <button type="button" @click="sync.resolveSettings('local')">Use this browser's settings</button>
            </div>
            <ul class="revision-list">
              <li v-for="conflict in conflicts" :key="conflict.id">
                <div>
                  <strong>{{ deviceLabel(conflict.sourceId) }}</strong>
                  <span>Saved {{ new Date(conflict.createdAt).toLocaleString() }}</span>
                </div>
                <button type="button" @click="sync.resolveSettings(conflict.id)">Use these cloud settings</button>
              </li>
            </ul>
          </fieldset>

          <fieldset v-if="workspace && revisions.length > 0" :disabled="busy">
            <legend>Saved cloud history</legend>
            <p v-if="legacyWorkspace">These saved copies remain unchanged. Opening a copy never replaces this browser's recordings.</p>
            <template v-else>
              <p>Sync adds the latest copies from other devices as separate, read-only sources. Each browser keeps its latest three complete cloud copies and permanently removes its older copies after a successful upload.</p>
              <p class="hint">Copies contain up to two years of hourly history, selected moments, warnings and device history. Raw recordings stay local. Interrupted uploads that cannot be reused may remain in Drive.</p>
            </template>
            <details>
              <summary>Browse {{ revisions.length }} saved {{ revisions.length === 1 ? 'copy' : 'copies' }}</summary>
              <ul class="revision-list">
                <li v-for="revision in newestRevisions" :key="revision.id">
                  <div>
                    <strong>{{ revision.source.label }}</strong>
                    <span>Captured {{ new Date(revision.exportedAt).toLocaleString() }}</span>
                    <span v-if="revision.storage === 'snapshot'">{{ revision.sessions.toLocaleString() }} {{ revision.sessions === 1 ? 'session' : 'sessions' }} · {{ revision.hours.toLocaleString() }} hourly summaries</span>
                    <span v-else>{{ revision.sessions.toLocaleString() }} {{ revision.sessions === 1 ? 'session' : 'sessions' }} · {{ revision.samples.toLocaleString() }} samples</span>
                  </div>
                  <button type="button" @click="sync.openRevision(revision.id)">Open saved history</button>
                </li>
              </ul>
            </details>
          </fieldset>

          <fieldset v-if="workspace" :disabled="busy">
            <legend>Remove cloud workspace</legend>
            <details>
              <summary>Move workspace to Google Drive trash</summary>
              <div class="delete-workspace">
                <p>This moves <strong>{{ workspace.name }}</strong> and all its contents to Google Drive trash, including shared settings, saved history and any files added manually. Other devices will lose access. Local recordings and imported copies remain in this browser.</p>
                <label class="field">
                  <span>Type {{ workspace.name }} to confirm</span>
                  <input v-model="deletionName" type="text" autocomplete="off" data-testid="delete-workspace-name" />
                </label>
                <button type="button" class="danger" :disabled="!mayDelete" @click="sync.trashWorkspace(deletionName)">Move workspace to trash</button>
              </div>
            </details>
          </fieldset>
        </template>
      </template>
    </template>

    <div v-if="busy" class="actions" role="status">
      <span>{{ progress ?? 'Syncing with Google…' }}</span>
      <button type="button" @click="sync.cancel()">Cancel sync</button>
    </div>
    <p v-if="failure" class="failure" role="alert">{{ failure }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.sync-panel { display: flex; flex-direction: column; gap: 1.25rem; padding: var(--pad); }
header, .field, .delete-workspace, .create-workspace { display: flex; flex-direction: column; gap: 0.6rem; }
h3, p { margin: 0; }
h3 { font-size: 1.05rem; }
p, span, label, summary { font-size: var(--text-copy); }
p { max-width: 75ch; color: var(--ink-secondary); }
fieldset { display: flex; flex-direction: column; gap: 0.85rem; border: 0; border-top: 1px solid var(--gridline); padding: 1rem 0 0; margin: 0; min-width: 0; }
legend { padding: 0 0.5rem 0 0; font-weight: 600; }
.check { display: flex; align-items: flex-start; gap: 0.6rem; min-height: var(--tap); }
.check input { flex: none; margin-top: 0.25rem; }
.hint { font-size: 0.8rem; }
.actions, .label-form { display: flex; flex-wrap: wrap; gap: 0.65rem; align-items: center; }
.label-form { align-items: flex-end; }
.field { min-width: 0; }
input[type='text'], select { width: 100%; max-width: 30rem; min-width: 0; min-height: var(--tap); padding: 0.5rem 0.65rem; color: var(--ink); border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--raised); font: inherit; }
button { min-height: var(--tap); padding: 0.5rem 0.85rem; color: var(--ink); border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--raised); font: inherit; }
button:disabled, fieldset:disabled { opacity: 0.6; }
summary { cursor: pointer; min-height: var(--tap); padding-block: 0.65rem; }
.revision-list { display: flex; flex-direction: column; gap: 0.85rem; list-style: none; padding: 0; margin: 0.75rem 0 0; }
.revision-list li { display: flex; flex-wrap: wrap; gap: 0.75rem 1.25rem; align-items: center; justify-content: space-between; padding-bottom: 0.85rem; border-bottom: 1px solid var(--gridline); }
.revision-list li > div { display: flex; flex-direction: column; gap: 0.2rem; overflow-wrap: anywhere; }
.revision-list span { color: var(--ink-secondary); }
.conflict { border-top-color: var(--status-warning); }
.failure, .danger { color: var(--status-critical-ink); }
.create-workspace button, .delete-workspace button { align-self: flex-start; }
select:focus-visible, summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
</style>
