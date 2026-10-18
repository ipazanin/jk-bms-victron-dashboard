import type { HistoryStore } from '../../application/history/port'

export function readOnlyHistoryStore(store: HistoryStore): HistoryStore {
  const refuse = async (): Promise<never> => {
    throw new Error('Imported archives are read-only.')
  }

  return {
    get availability() { return store.availability },
    warningsOf: store.warningsOf.bind(store),
    listWarnings: store.listWarnings.bind(store),
    warningsInWindow: store.warningsInWindow.bind(store),
    listSessions: store.listSessions.bind(store),
    listDevices: store.listDevices.bind(store),
    readSession: store.readSession.bind(store),
    streamChunks: store.streamChunks.bind(store),
    readRingLedger: store.readRingLedger.bind(store),
    listRingLedgers: store.listRingLedgers.bind(store),
    usage: store.usage.bind(store),
    watch: store.watch.bind(store),
    close: store.close.bind(store),
    openSession: refuse,
    commitChunk: refuse,
    closeSession: refuse,
    deleteSession: refuse,
    appendWarning: refuse,
    upsertDevice: refuse,
    renameDevice: refuse,
    appendRingSnapshot: refuse,
    appendSolarHistory: refuse,
    setPackClock: refuse,
    deleteRingLedger: refuse,
    recover: refuse,
  }
}
