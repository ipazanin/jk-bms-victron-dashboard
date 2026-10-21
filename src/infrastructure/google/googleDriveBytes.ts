import { CLOUD_SNAPSHOT_BYTES } from '../../domain/sync/limits'
import { checkGoogleId, DRIVE_FILES } from './googleDrive'
import { googleRequest } from './googleRequest'

export async function downloadGoogleArchive(fileId: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  checkGoogleId(fileId)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CLOUD_SNAPSHOT_BYTES) throw new Error('The archive download limit is invalid.')
  const response = await googleRequest(`${DRIVE_FILES}/${encodeURIComponent(fileId)}?alt=media`, signal)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Google returned an empty archive file.')
  const bytes = new Uint8Array(maxBytes)
  let received = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (received > maxBytes) throw new Error('The downloaded archive exceeds its declared size.')
      bytes.set(chunk.value, received - chunk.value.byteLength)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return bytes.slice(0, received)
}
