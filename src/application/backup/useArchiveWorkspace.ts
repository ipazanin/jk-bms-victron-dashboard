import { openArchiveRepository } from '../../infrastructure/backup/openArchiveRepository'
import { downloadArchive } from '../../infrastructure/backup/downloadArchive'
import { exportArchiveWorkbooks, importArchiveWorkbooks } from '../../infrastructure/backup/excel/archiveWorkbookClient'
import { downloadJson } from '../../infrastructure/history/downloadJson'
import { provideHistoryEnvironment, useHistoryBrowser } from '../history/historyBrowser'
import { route } from '../route'
import { useTelemetry } from '../telemetry'
import { createArchiveWorkspace } from './archiveWorkspace'

const workspace = createArchiveWorkspace({
  openRepository: openArchiveRepository,
  showHistory: (store, capturedAt) => {
    const browser = useHistoryBrowser()
    browser.unloadSession()
    provideHistoryEnvironment({ store, downloadJson, ...(capturedAt === undefined ? {} : { capturedAt }) })
    if (route.value.name === 'session') void browser.loadSession(route.value.id)
  },
  radiosBusy: () => {
    const telemetry = useTelemetry()
    return telemetry.bmsState.value !== 'idle' || telemetry.solarState.value !== 'idle' || telemetry.recording.value.sessionId !== null
  },
  preferencesChanged: () => {
    useTelemetry().restoreRemembered(true)
  },
  exportFile: async (snapshots, signal) => {
    const exported = await exportArchiveWorkbooks(snapshots, { signal })
    signal.throwIfAborted()
    downloadArchive(exported.fileName, exported.blob)
  },
  importFile: (file, signal) => importArchiveWorkbooks(file, { signal }),
})

export function useArchiveWorkspace() {
  return workspace
}
