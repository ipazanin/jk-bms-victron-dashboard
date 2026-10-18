import type { ArchiveSnapshot } from '../../../domain/backup/ArchiveSnapshot'
import type { ArchiveWorkerRequest } from './ArchiveWorkerRequest'
import type { ArchiveWorkerResponse } from './ArchiveWorkerResponse'
import type { ArchiveWorkbookJobOptions } from './ArchiveWorkbookJobOptions'
import type { ArchiveWorkbookDownload } from './ArchiveWorkbookDownload'
import { MAX_ARCHIVE_FILE_BYTES } from './limits'

export async function exportArchiveWorkbooks(snapshots: readonly ArchiveSnapshot[], options: ArchiveWorkbookJobOptions = {}): Promise<ArchiveWorkbookDownload> {
  const response = await runWorker({ operation: 'export', snapshots }, options)
  if (response.kind !== 'exported') throw new Error('Unexpected export response')
  return { blob: new Blob([response.file.bytes], { type: response.file.mimeType }), fileName: response.file.fileName, partCount: response.file.partCount }
}

export async function importArchiveWorkbooks(file: Blob | ArrayBuffer, options: ArchiveWorkbookJobOptions = {}): Promise<readonly ArchiveSnapshot[]> {
  options.signal?.throwIfAborted()
  const size = file instanceof Blob ? file.size : file.byteLength
  if (size === 0 || size > MAX_ARCHIVE_FILE_BYTES) throw new Error('Archive file size is outside the supported limits')
  const bytes = file instanceof Blob ? await file.arrayBuffer() : file.slice(0)
  const response = await runWorker({ operation: 'import', bytes }, options, [bytes])
  if (response.kind !== 'imported') throw new Error('Unexpected import response')
  return response.snapshots
}

function runWorker(request: ArchiveWorkerRequest, options: ArchiveWorkbookJobOptions, transfer: Transferable[] = []): Promise<ArchiveWorkerResponse> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./archiveWorkbook.worker.ts', import.meta.url), { type: 'module' })
    function cleanup(): void {
      worker.terminate()
      options.signal?.removeEventListener('abort', abort)
    }
    function abort(): void {
      cleanup()
      reject(new DOMException('Archive operation cancelled', 'AbortError'))
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<ArchiveWorkerResponse>) => {
      if (event.data.kind === 'progress') {
        options.onProgress?.(event.data.progress)
        return
      }
      cleanup()
      if (event.data.kind === 'error') reject(new Error(event.data.message))
      else resolve(event.data)
    }
    worker.onerror = (event) => {
      cleanup()
      reject(new Error(event.message || 'Archive worker failed'))
    }
    try { worker.postMessage(request, transfer) }
    catch (error) { cleanup(); reject(error) }
  })
}
