import { watch } from 'vue'
import { googleConfig } from '../../infrastructure/google/googleConfig'
import { forgetGoogleAccess, prepareGoogleIdentity, requestGoogleAccess, subscribeGoogleAccess } from '../../infrastructure/google/googleAuth'
import { prepareGooglePicker } from '../../infrastructure/google/googlePicker'
import { remote } from '../../infrastructure/google/googleSyncRemote'
import { createGoogleWorkspace, listGoogleWorkspaces, pickGoogleWorkspace, trashGoogleWorkspace } from '../../infrastructure/google/googleWorkspaces'
import { captureArchivePreferences } from '../backup/preferences'
import { useArchiveWorkspace } from '../backup/useArchiveWorkspace'
import { useTelemetry } from '../telemetry'
import { createGoogleSyncController } from './googleSyncController'
import { applySharedPreferences, loadGoogleSyncState, saveGoogleSyncState } from './syncPreferences'

const sync = createGoogleSyncController({
  remote,
  configured: () => googleConfig() !== null,
  load: loadGoogleSyncState,
  save: saveGoogleSyncState,
  prepare: async () => { await Promise.all([prepareGoogleIdentity(), prepareGooglePicker()]) },
  authorize: requestGoogleAccess,
  forgetAccess: forgetGoogleAccess,
  subscribeAccess: subscribeGoogleAccess,
  listWorkspaces: listGoogleWorkspaces,
  createWorkspace: createGoogleWorkspace,
  chooseWorkspace: pickGoogleWorkspace,
  trashWorkspace: trashGoogleWorkspace,
  capture: (includeSecret, detail) => useArchiveWorkspace().captureForSync(includeSecret, detail),
  sourceId: () => useArchiveWorkspace().source.value?.id ?? null,
  importArchive: (snapshot, select) => useArchiveWorkspace().saveSyncedArchive(snapshot, select),
  imported: () => useArchiveWorkspace().imported.value,
  preferences: captureArchivePreferences,
  applyPreferences: applySharedPreferences,
  radiosBusy: () => {
    const telemetry = useTelemetry()
    return telemetry.bmsState.value !== 'idle' || telemetry.solarState.value !== 'idle' || telemetry.recording.value.sessionId !== null
  },
  subscribeRecordingEnd: (listener) => {
    const telemetry = useTelemetry()
    let subscribed = true
    const stop = watch(() => telemetry.recording.value.sessionId, async (sessionId, previousSessionId) => {
      if (previousSessionId === null || sessionId === previousSessionId) return
      await telemetry.drain()
      if (subscribed) listener()
    })
    return () => { subscribed = false; stop() }
  },
  recording: () => useTelemetry().recording.value.sessionId !== null,
  now: Date.now,
})

export function useGoogleSync() {
  return sync
}
