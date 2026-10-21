import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArchiveSnapshot } from '../src/domain/backup/ArchiveSnapshot'
import type { CloudCatalog } from '../src/domain/sync/CloudCatalog'
import { updateCloudWorkspace } from '../src/application/sync/cloudWorkspaceJson'
import { readJsonWorkspace, writeJsonWorkspace } from '../src/infrastructure/google/googleWorkspaceDocuments'
import { createFakeGoogleWorkspace } from './support/fakeGoogleWorkspace'
import { packSamples, SAMPLE_EPOCH, sessionRecord } from './support/samples'
import { summarizeSessionHours } from '../src/domain/history/summarizeSessionHours'

vi.mock('../src/infrastructure/google/googleAuth', () => ({ googleAccessToken: () => 'token', forgetGoogleAccess: vi.fn() }))
vi.mock('../src/domain/sync/limits', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/domain/sync/limits')>(), CLOUD_DOCUMENT_BYTES: 8192 }))

const workspace = { id: 'folder', folderId: 'folder', name: 'Boat', version: 3 as const }
const signal = new AbortController().signal
const empty: CloudCatalog = { archives: [], settings: [], documents: [] }
let drive: ReturnType<typeof createFakeGoogleWorkspace>
beforeEach(() => {
  drive = createFakeGoogleWorkspace()
  vi.stubGlobal('fetch', drive.fetchGoogle)
})
afterEach(() => vi.unstubAllGlobals())

function snapshot(sourceId = 'tablet', hours = 0): ArchiveSnapshot {
  return {
    format: 'shunt-archive', version: 2, source: { id: sourceId, label: sourceId }, exportedAt: SAMPLE_EPOCH,
    preferences: [{ key: 'shunt.theme', value: 'dark' }],
    stores: {
      sessions: [sessionRecord()], chunks: [], devices: [], meta: [], warnings: [], ringRecords: [], ringReads: [],
      hours: Array.from({ length: hours }, (_, index) => summarizeSessionHours('session-0001',
        packSamples(2).map((sample) => ({ ...sample, at: sample.at + index * 3600000 })), [])).flat(),
    },
  }
}

describe('immutable JSON workspace publications', () => {
  it('writes one verified JSON file and replaces only the incorporated publication', async () => {
    const first = await writeJsonWorkspace(workspace, await updateCloudWorkspace(empty, snapshot()), signal)
    expect(drive.files.size).toBe(1)
    const file = [...drive.files.values()][0]!
    expect(file.file.name).toBe('shunt.json')
    expect(file.file.mimeType).toBe('application/json')
    expect(JSON.parse(new TextDecoder().decode(file.bytes)).archives).toHaveLength(1)
    const loaded = await readJsonWorkspace(workspace, signal)
    const updated = await updateCloudWorkspace(loaded, snapshot('phone'))
    const second = await writeJsonWorkspace(workspace, updated, signal)
    expect(drive.files.size).toBe(1)
    expect(second.documents?.[0]?.id).not.toBe(first.documents?.[0]?.id)
    expect((await readJsonWorkspace(workspace, signal)).archives).toHaveLength(2)
  })

  it('preserves unseen concurrent replacements and combines them on a later sync', async () => {
    await writeJsonWorkspace(workspace, await updateCloudWorkspace(empty, snapshot()), signal)
    const left = await readJsonWorkspace(workspace, signal)
    const right = await readJsonWorkspace(workspace, signal)
    await writeJsonWorkspace(workspace, await updateCloudWorkspace(left, snapshot('phone')), signal)
    await writeJsonWorkspace(workspace, await updateCloudWorkspace(right, snapshot('laptop')), signal)
    expect(drive.files.size).toBe(2)
    const merged = await readJsonWorkspace(workspace, signal)
    expect(new Set(merged.archives.map((revision) => revision.source.id))).toEqual(new Set(['tablet', 'phone', 'laptop']))
    const updated = await updateCloudWorkspace(merged)
    expect(updated).not.toBe(merged)
    await writeJsonWorkspace(workspace, updated, signal)
    expect(drive.files.size).toBe(1)
  })

  it('keeps incomplete split uploads invisible and does not retire the prior publication', async () => {
    const first = await writeJsonWorkspace(workspace, await updateCloudWorkspace(empty, snapshot()), signal)
    const priorId = first.documents![0]!.id
    const updated = await updateCloudWorkspace(first, snapshot('large-source', 5))
    let uploads = 0
    drive.hooks.beforeRequest = (url, request) => {
      if (url.pathname.startsWith('/upload/') && request.method === 'PUT' && ++uploads === 2) throw new Error('Connection interrupted')
    }
    await expect(writeJsonWorkspace(workspace, updated, signal)).rejects.toThrow()
    delete drive.hooks.beforeRequest
    expect(drive.files.has(priorId)).toBe(true)
    expect((await readJsonWorkspace(workspace, signal)).archives).toEqual(first.archives)
  })

  it('publishes a split group only after every part has been verified', async () => {
    const catalog = await updateCloudWorkspace(empty, snapshot('large-source', 5))
    const written = await writeJsonWorkspace(workspace, catalog, signal)
    expect(written.documents!.length).toBeGreaterThan(1)
    expect([...drive.files.values()].filter((entry) => entry.file.appProperties?.shuntRole === 'document')).toHaveLength(1)
    expect((await readJsonWorkspace(workspace, signal)).archives).toEqual(catalog.archives)
    drive.files.delete(written.documents![1]!.id)
    await expect(readJsonWorkspace(workspace, signal)).rejects.toThrow('missing files')
  })

  it('refuses a corrupted download before publishing or deleting anything', async () => {
    const updated = await updateCloudWorkspace(empty, snapshot())
    drive.hooks.beforeRequest = (url) => {
      if (url.searchParams.get('alt') === 'media') {
        const saved = drive.files.get(url.pathname.split('/').at(-1)!)!
        saved.bytes[0] = 0
      }
    }
    await expect(writeJsonWorkspace(workspace, updated, signal)).rejects.toThrow('checksum')
    expect([...drive.files.values()].every((entry) => entry.file.appProperties?.shuntRole === 'pending-document')).toBe(true)
    expect(drive.fetchGoogle.mock.calls.some(([, request]) => request?.method === 'DELETE')).toBe(false)
  })

  it('does not publish if cancellation occurs during verification', async () => {
    const cancelled = new AbortController()
    drive.hooks.beforeRequest = (url) => {
      if (url.searchParams.get('alt') === 'media') cancelled.abort()
    }
    await expect(writeJsonWorkspace(workspace, await updateCloudWorkspace(empty, snapshot()), cancelled.signal)).rejects.toThrow()
    expect(drive.fetchGoogle.mock.calls.some(([, request]) => request?.method === 'PATCH')).toBe(false)
  })

  it('refuses malformed completed files instead of returning a partial workspace', async () => {
    const written = await writeJsonWorkspace(workspace, await updateCloudWorkspace(empty, snapshot()), signal)
    drive.files.get(written.documents![0]!.id)!.file = { ...drive.files.get(written.documents![0]!.id)!.file, description: '{invalid' }
    await expect(readJsonWorkspace(workspace, signal)).rejects.toThrow()
  })

  it('rejects legacy workspace writes before making any request', async () => {
    await expect(writeJsonWorkspace({ ...workspace, version: 2 }, empty, signal)).rejects.toThrow('read-only')
    expect(drive.fetchGoogle).not.toHaveBeenCalled()
  })
})
