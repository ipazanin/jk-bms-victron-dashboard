import { exportArchiveJson, importArchiveJson } from './archiveJson'
import type { ArchiveWorkerRequest } from './ArchiveWorkerRequest'
import type { ArchiveWorkerResponse } from './ArchiveWorkerResponse'

const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ArchiveWorkerRequest>) => void) | null
  postMessage: (response: ArchiveWorkerResponse, transfer?: Transferable[]) => void
}

worker.onmessage = (event) => {
  try {
    if (event.data.operation === 'export') {
      const file = exportArchiveJson(event.data.snapshots)
      worker.postMessage({ kind: 'exported', file }, [file.bytes.buffer])
    } else {
      worker.postMessage({ kind: 'imported', snapshots: importArchiveJson(event.data.bytes) })
    }
  } catch (error) {
    worker.postMessage({ kind: 'error', message: error instanceof Error ? error.message : 'Could not process this archive' })
  }
}
