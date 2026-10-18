import { exportArchiveWorkbookBundle, importArchiveWorkbookBundle } from './archiveWorkbook'
import type { ArchiveWorkerRequest } from './ArchiveWorkerRequest'
import type { ArchiveWorkerResponse } from './ArchiveWorkerResponse'
import type { ArchiveWorkbookProgress } from './ArchiveWorkbookProgress'

const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ArchiveWorkerRequest>) => void) | null
  postMessage: (response: ArchiveWorkerResponse, transfer?: Transferable[]) => void
}

worker.onmessage = (event) => {
  const onProgress = (progress: ArchiveWorkbookProgress): void => worker.postMessage({ kind: 'progress', progress })
  try {
    if (event.data.operation === 'export') {
      const file = exportArchiveWorkbookBundle(event.data.snapshots, { onProgress })
      worker.postMessage({ kind: 'exported', file }, [file.bytes.buffer])
    } else {
      const snapshots = importArchiveWorkbookBundle(event.data.bytes, { onProgress })
      worker.postMessage({ kind: 'imported', snapshots })
    }
  } catch (error) {
    worker.postMessage({ kind: 'error', message: error instanceof Error ? error.message : 'Could not process this archive' })
  }
}
