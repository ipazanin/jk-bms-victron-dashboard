import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeCloudWorkspace, encodeCloudWorkspace, mergeCloudCatalogs, updateCloudWorkspace } from '../src/application/sync/cloudWorkspaceJson'
import { createFakeGoogleWorkspace } from './support/fakeGoogleWorkspace'
import { readJsonWorkspace, writeJsonWorkspace } from '../src/infrastructure/google/googleWorkspaceDocuments'
import { hashCloudBytes } from '../src/application/sync/cloudWorkspaceJson'
import type { CloudCatalog } from '../src/domain/sync/CloudCatalog'
import type { CloudWorkspace } from '../src/domain/sync/CloudWorkspace'
import type { ArchiveSnapshot } from '../src/domain/backup/ArchiveSnapshot'

vi.mock('../src/infrastructure/google/googleAuth', () => ({ googleAccessToken: () => 'test-token', forgetGoogleAccess: vi.fn() }))
vi.mock('../src/domain/sync/limits', async (original) => ({ ...await original<typeof import('../src/domain/sync/limits')>(), CLOUD_ARCHIVE_BYTES: 8192 }))

const workspace: CloudWorkspace = { id: 'folder', folderId: 'folder', name: 'Boat', version: 3 }
const signal = new AbortController().signal

function emptySnapshot(label: string): ArchiveSnapshot {
  return {
    format: 'shunt-archive', version: 2, exportedAt: 1_000,
    source: { id: 'phone', label },
    stores: { sessions: [], chunks: [], hours: [], devices: [], meta: [], warnings: [], ringRecords: [], ringReads: [] },
    preferences: [],
  }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function severalSources(): Promise<CloudCatalog> {
  let catalog: CloudCatalog = { archives: [], settings: [], documents: [] }
  for (let index = 0; index < 4; index++) {
    catalog = await updateCloudWorkspace(catalog, { ...emptySnapshot('Boat '.repeat(90)), source: { id: `source-${index}`, label: 'Boat '.repeat(90) } })
  }
  return catalog
}

async function seedPublication(drive: ReturnType<typeof createFakeGoogleWorkspace>, catalog: CloudCatalog, publicationId: string, maximumBytes = 4096): Promise<string[]> {
  const encoded = encodeCloudWorkspace(catalog, publicationId, maximumBytes)
  const ids: string[] = []
  for (const [index, bytes] of encoded.entries()) {
    const id = `${publicationId}-${index}`
    const hash = await hashCloudBytes(bytes)
    drive.files.set(id, { bytes, file: {
      id, name: `${id}.json`, mimeType: 'application/json', size: String(bytes.byteLength), parents: ['folder'],
      description: JSON.stringify({ publicationId, index, count: encoded.length, hash, bytes: bytes.byteLength }),
      appProperties: { shuntCloud: '1', shuntRole: index === 0 ? 'document' : 'pending-document', shuntWorkspace: 'folder', shuntPublication: publicationId, shuntHash: hash },
    } })
    ids.push(id)
  }
  return ids
}

describe('Google JSON workspace recovery', () => {
  it('keeps the newest source revision newest after its browser clock moves backwards', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(20_000)
    const earlier = await updateCloudWorkspace({ archives: [], settings: [], documents: [] }, emptySnapshot('Earlier'))
    vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const changed = await updateCloudWorkspace(earlier, emptySnapshot('Changed'))
    const read = mergeCloudCatalogs([await decodeCloudWorkspace(encodeCloudWorkspace(changed, 'publication'))])
    expect(read.archives.at(-1)?.source.label).toBe('Changed')
    expect(await updateCloudWorkspace(read, emptySnapshot('Changed'))).toBe(read)
  })

  it.each(['network failure', 'cancellation'])('finishes retiring old split files after %s without deleting another upload', async (interruption) => {
    const drive = createFakeGoogleWorkspace()
    vi.stubGlobal('fetch', drive.fetchGoogle)
    const oldIds = await seedPublication(drive, await severalSources(), 'old')
    const pendingIds = await seedPublication(drive, await severalSources(), 'other-upload')
    const pendingHead = drive.files.get(pendingIds[0]!)!
    pendingHead.file = { ...pendingHead.file, appProperties: { ...pendingHead.file.appProperties, shuntRole: 'pending-document' } }
    const writing = new AbortController()
    expect(oldIds.length).toBeGreaterThan(1)
    const loaded = await readJsonWorkspace(workspace, signal)
    const changed = await updateCloudWorkspace(loaded, emptySnapshot('New phone'))
    let rejected = false
    drive.hooks.beforeRequest = (url, request) => {
      if (request.method === 'DELETE' && url.pathname.endsWith(oldIds[1]!) && !rejected) {
        rejected = true
        if (interruption === 'cancellation') writing.abort()
        else throw new Error('Temporary deletion failure')
      }
    }
    const written = await writeJsonWorkspace(workspace, changed, writing.signal)
    expect(written.cleanupFailure).toContain('saved')
    const reread = await readJsonWorkspace(workspace, signal)
    expect(reread.archives).toHaveLength(5)
    const retry = await updateCloudWorkspace(reread)
    expect(retry).not.toBe(reread)
    await writeJsonWorkspace(workspace, retry, signal)
    expect(oldIds.some((id) => drive.files.has(id))).toBe(false)
    expect(pendingIds.every((id) => drive.files.has(id))).toBe(true)
    expect((await readJsonWorkspace(workspace, signal)).archives).toHaveLength(5)
  })

  it('merges duplicate near-limit publications without counting their shared history twice', async () => {
    const drive = createFakeGoogleWorkspace()
    vi.stubGlobal('fetch', drive.fetchGoogle)
    const catalog = await severalSources()
    await seedPublication(drive, catalog, 'left')
    await seedPublication(drive, catalog, 'right')
    const physicalBytes = [...drive.files.values()].reduce((sum, entry) => sum + entry.bytes.byteLength, 0)
    expect(physicalBytes).toBeGreaterThan(8192)
    const read = await readJsonWorkspace(workspace, signal)
    expect(read.archives).toHaveLength(4)
    const merged = await updateCloudWorkspace(read)
    await writeJsonWorkspace(workspace, merged, signal)
    expect((await readJsonWorkspace(workspace, signal)).archives).toHaveLength(4)
  })

})
