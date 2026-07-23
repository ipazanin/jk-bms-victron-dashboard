import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { describeHistoryStore } from './support/describeHistoryStore'

// The fake runs the contract in an environment where `indexedDB` is genuinely undefined, which is
// the whole reason it exists: everything above the port is exercised with no database at all, and
// nothing above the port is allowed to need one.

describeHistoryStore('MemoryHistoryStore', async () => {
  const store = new MemoryHistoryStore()
  return {
    store,
    dispose: async () => store.close(),
  }
})
