import type { ArchiveSnapshot } from '../../../domain/backup/ArchiveSnapshot'
import type { ArchiveWorkerRequest } from './ArchiveWorkerRequest'
import type { ArchiveWorkerResponse } from './ArchiveWorkerResponse'
import { MAX_ARCHIVE_FILE_BYTES } from './limits'

export async function exportArchiveFile(snapshots: readonly ArchiveSnapshot[], signal?: AbortSignal) {
  const response = await runWorker({ operation: 'export', snapshots }, signal)
  if (response.kind !== 'exported') throw new Error('Unexpected export response')
  return { blob: new Blob([response.file.bytes], { type: response.file.mimeType }), fileName: response.file.fileName }
}

export async function importArchiveFile(file: Blob | ArrayBuffer, signal?: AbortSignal): Promise<readonly ArchiveSnapshot[]> {
  signal?.throwIfAborted()
  const size = file instanceof Blob ? file.size : file.byteLength
  if (size === 0 || size > MAX_ARCHIVE_FILE_BYTES) throw new Error('Archive file size is outside the supported limits')
  const bytes = file instanceof Blob ? await file.arrayBuffer() : file.slice(0)
  const response = await runWorker({ operation: 'import', bytes }, signal, [bytes])
  if (response.kind !== 'imported') throw new Error('Unexpected import response')
  return response.snapshots
}

function runWorker(request: ArchiveWorkerRequest, signal?: AbortSignal, transfer: Transferable[] = []): Promise<ArchiveWorkerResponse> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./archiveJson.worker.ts', import.meta.url), { type: 'module' })
    function cleanup(): void {
      worker.terminate()
      signal?.removeEventListener('abort', abort)
    }
    function abort(): void {
      cleanup()
      reject(new DOMException('Archive operation cancelled', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<ArchiveWorkerResponse>) => {
      cleanup()
      if (event.data.kind === 'error') reject(new Error(event.data.message))
      else resolve(event.data)
    }
    worker.onerror = (event) => {
      cleanup()
      reject(new Error(event.message || 'Archive worker failed'))
    }
    worker.onmessageerror = () => {
      cleanup()
      reject(new Error('Could not read the archive worker response'))
    }
    try {
      worker.postMessage(request, transfer)
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}
