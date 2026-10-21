import { vi } from 'vitest'
import type { DriveFile } from '../../src/infrastructure/google/DriveFile'

export function createFakeGoogleWorkspace() {
  const files = new Map<string, { file: DriveFile, bytes: Uint8Array }>()
  const uploads = new Map<string, DriveFile>()
  let sequence = 0
  const hooks: { beforeRequest?: (url: URL, request: RequestInit) => void } = {}
  const fetchGoogle = vi.fn<typeof fetch>(async (input, request = {}) => {
    const url = new URL(String(input))
    hooks.beforeRequest?.(url, request)
    request.signal?.throwIfAborted()
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (url.pathname === '/upload/drive/v3/files' && request.method === 'POST') {
      const id = `file-${++sequence}`
      uploads.set(id, { ...JSON.parse(request.body as string), id })
      return new Response(null, { headers: { Location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${id}` } })
    }
    if (url.pathname === '/upload/drive/v3/files' && request.method === 'PUT') {
      const id = url.searchParams.get('upload_id')!
      const bytes = new Uint8Array(request.body as ArrayBuffer)
      const file = { ...uploads.get(id)!, size: String(bytes.byteLength) }
      files.set(id, { file, bytes })
      return json(file)
    }
    if (url.pathname === '/drive/v3/files') return json({ files: [...files.values()].map((entry) => entry.file) })
    const id = url.pathname.split('/').at(-1)!
    if (id === 'folder') return json({ id, name: 'Boat', mimeType: 'application/vnd.google-apps.folder', appProperties: { shuntCloud: '1', shuntRole: 'workspace', shuntVersion: '3' } })
    const saved = files.get(id)
    if (!saved) return json({}, 404)
    if (request.method === 'DELETE') {
      files.delete(id)
      return new Response(null, { status: 204 })
    }
    if (request.method === 'PATCH') {
      const changes = JSON.parse(request.body as string)
      saved.file = { ...saved.file, ...changes, appProperties: { ...saved.file.appProperties, ...changes.appProperties } }
      return json(saved.file)
    }
    if (url.searchParams.get('alt') === 'media') return new Response(saved.bytes.slice().buffer)
    return json(saved.file)
  })
  return { files, fetchGoogle, hooks }
}
