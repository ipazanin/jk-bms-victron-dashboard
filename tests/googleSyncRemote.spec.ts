import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudArchiveRevision } from '../src/domain/sync/CloudArchiveRevision'
import { CLOUD_BLOCK_BYTES } from '../src/domain/sync/limits'
import { remote } from '../src/infrastructure/google/googleSyncRemote'
import { googleRequest } from '../src/infrastructure/google/googleRequest'
import { createGoogleWorkspace, listGoogleWorkspaces, trashGoogleWorkspace } from '../src/infrastructure/google/googleWorkspaces'

const forget = vi.hoisted(() => vi.fn())
vi.mock('../src/infrastructure/google/googleAuth', () => ({ googleAccessToken: () => 'memory-token', forgetGoogleAccess: forget }))
const fetchGoogle = vi.fn<typeof fetch>()
const workspace = { id: 'sheet-id', name: 'My archive', folderId: 'folder-id' }
const signal = new AbortController().signal
const hash = 'a'.repeat(64)

beforeEach(() => {
  fetchGoogle.mockReset()
  forget.mockReset()
  vi.stubGlobal('fetch', fetchGoogle)
})
afterEach(() => vi.unstubAllGlobals())

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

function mockWorkspace(valid = true) {
  fetchGoogle.mockResolvedValueOnce(json({ id: workspace.id, name: workspace.name, mimeType: 'application/vnd.google-apps.spreadsheet',
    parents: [workspace.folderId], appProperties: { shuntCloud: valid ? '1' : 'ledgerboard', shuntRole: 'catalog', shuntWorkspace: workspace.folderId } }))
  fetchGoogle.mockResolvedValueOnce(json({ id: workspace.folderId, name: workspace.name, mimeType: 'application/vnd.google-apps.folder',
    appProperties: { shuntCloud: '1', shuntRole: 'workspace' } }))
  fetchGoogle.mockResolvedValueOnce(json({ valueRanges: [{ values: [['format', 'shunt-cloud'], ['version', 1], ['folderId', workspace.folderId]] }] }))
}

const archive: CloudArchiveRevision = {
  id: 'revision', source: { id: 'phone', label: '=FORMULA()' }, exportedAt: 1_700_000_000_000,
  manifestFileId: 'manifest', manifestHash: hash, contentHash: hash, sessions: 1, samples: 2, bytes: 3,
}

describe('Google sync transport', () => {
  it('appends revisions as RAW rows with cancellation and bearer authorization', async () => {
    fetchGoogle.mockResolvedValue(json({}))
    await remote.appendArchive(workspace, archive, signal)
    const [url, request] = fetchGoogle.mock.calls[0]!
    expect(String(url)).toContain('valueInputOption=RAW')
    expect(String(url)).toContain('insertDataOption=INSERT_ROWS')
    expect(request!.signal).toBe(signal)
    expect(new Headers(request!.headers).get('Authorization')).toBe('Bearer memory-token')
    expect(JSON.parse(request!.body as string).values[0][2]).toBe('=FORMULA()')
  })

  it('writes actual settings values in separate columns', async () => {
    fetchGoogle.mockResolvedValue(json({}))
    await remote.appendSettings(workspace, { id: 'settings', sourceId: 'phone', parents: [], createdAt: 1_700_000_000_000,
      preferences: [{ key: 'shunt.theme', value: 'dark' }] }, signal)
    expect(JSON.parse(fetchGoogle.mock.calls[0]![1]!.body as string).values).toEqual([['settings', 'phone', '[]', 1_700_000_000_000, 'dark', '', '', '']])
  })

  it('rejects oversized uploads before any network request', async () => {
    await expect(remote.uploadBlock(workspace, new Uint8Array(CLOUD_BLOCK_BYTES + 1), hash, signal)).rejects.toThrow('upload limit')
    expect(fetchGoogle).not.toHaveBeenCalled()
  })

  it('stops a streamed download when bytes exceed the declared size', async () => {
    const cancelled = vi.fn()
    fetchGoogle.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])) },
      cancel: cancelled,
    })))
    await expect(remote.downloadBlock('block', 2, signal)).rejects.toThrow('declared size')
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('forgets expired access and never automatically retries a write', async () => {
    fetchGoogle.mockResolvedValue(new Response('', { status: 401 }))
    await expect(remote.appendArchive(workspace, archive, signal)).rejects.toThrow('Connect to Google again')
    expect(forget).toHaveBeenCalledOnce()
    expect(fetchGoogle).toHaveBeenCalledOnce()
  })

  it('surfaces throttling without retrying a write', async () => {
    fetchGoogle.mockResolvedValue(new Response('', { status: 429 }))
    await expect(remote.appendArchive(workspace, archive, signal)).rejects.toThrow('Wait a minute')
    expect(fetchGoogle).toHaveBeenCalledOnce()
  })

  it.each(['rateLimitExceeded', 'userRateLimitExceeded'])('treats a Drive 403 with %s as throttling', async (reason) => {
    fetchGoogle.mockResolvedValue(new Response(JSON.stringify({ error: { code: 403, errors: [{ domain: 'usageLimits', reason }] } }), { status: 403 }))
    await expect(googleRequest('https://www.googleapis.com/drive/v3/files', signal)).rejects.toThrow('Wait a minute')
  })

  it.each([
    ['a permission reason', JSON.stringify({ error: { code: 403, errors: [{ reason: 'insufficientFilePermissions' }] } })],
    ['a body that is not JSON', '<html>Forbidden</html>'],
  ])('reports refused access for a 403 with %s', async (_case, body) => {
    fetchGoogle.mockResolvedValue(new Response(body, { status: 403 }))
    await expect(googleRequest('https://www.googleapis.com/drive/v3/files', signal)).rejects.toThrow('Google refused access')
  })

  it('replaces the browser network error with a plain message', async () => {
    fetchGoogle.mockRejectedValue(new TypeError('NetworkError when attempting to fetch resource.'))
    await expect(googleRequest('https://www.googleapis.com/drive/v3/files', signal)).rejects.toThrow('Google could not be reached')
  })

  it('passes a cancellation during the request through unchanged', async () => {
    const cancelled = new AbortController()
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    fetchGoogle.mockImplementation(async () => {
      cancelled.abort(abort)
      throw abort
    })
    await expect(googleRequest('https://www.googleapis.com/drive/v3/files', cancelled.signal)).rejects.toBe(abort)
  })

  it('lists valid workspaces when another catalogue has left its folder', async () => {
    const catalog = { mimeType: 'application/vnd.google-apps.spreadsheet', name: 'Archive' }
    fetchGoogle.mockResolvedValue(json({ files: [
      { ...catalog, id: 'moved-sheet', parents: ['elsewhere'], appProperties: { shuntCloud: '1', shuntRole: 'catalog', shuntWorkspace: 'old-folder' } },
      { ...catalog, id: workspace.id, parents: [workspace.folderId], appProperties: { shuntCloud: '1', shuntRole: 'catalog', shuntWorkspace: workspace.folderId } },
    ] }))
    await expect(listGoogleWorkspaces(signal)).resolves.toEqual([{ id: workspace.id, name: 'Archive', folderId: workspace.folderId }])
  })

  it('makes a created workspace discoverable only after its tables are ready', async () => {
    fetchGoogle.mockResolvedValueOnce(json({ id: 'new-folder' }))
    fetchGoogle.mockResolvedValueOnce(json({ id: 'new-sheet' }))
    fetchGoogle.mockResolvedValueOnce(json({ sheets: [{ properties: { sheetId: 0 } }] }))
    fetchGoogle.mockResolvedValue(json({}))
    await expect(createGoogleWorkspace('New archive', signal)).resolves.toEqual({ id: 'new-sheet', name: 'New archive', folderId: 'new-folder' })
    const initialSheet = JSON.parse(fetchGoogle.mock.calls[1]![1]!.body as string)
    expect(initialSheet.appProperties.shuntRole).toBe('initializing')
    const headers = JSON.parse(fetchGoogle.mock.calls[4]![1]!.body as string)
    expect(headers.valueInputOption).toBe('RAW')
    const publish = fetchGoogle.mock.calls[5]!
    expect(publish[1]!.method).toBe('PATCH')
    expect(JSON.parse(publish[1]!.body as string).appProperties.shuntRole).toBe('catalog')
  })

  it('rejects block metadata outside the selected workspace', async () => {
    fetchGoogle.mockResolvedValue(json({ files: [{ id: 'block', size: '1', mimeType: 'application/octet-stream', parents: ['other-folder'],
      appProperties: { shuntCloud: '1', shuntRole: 'block', shuntWorkspace: workspace.folderId, shuntHash: hash } }] }))
    await expect(remote.listBlocks(workspace, signal)).rejects.toThrow('invalid archive block')
  })

  it('rejects repeated pagination tokens instead of looping', async () => {
    fetchGoogle.mockImplementation(async () => json({ files: [], nextPageToken: 'same-page' }))
    await expect(remote.listBlocks(workspace, signal)).rejects.toThrow('repeated file page')
    expect(fetchGoogle).toHaveBeenCalledTimes(2)
  })

  it('rejects another application spreadsheet before trashing anything', async () => {
    mockWorkspace(false)
    await expect(trashGoogleWorkspace(workspace, signal)).rejects.toThrow('invalid format or folder')
    expect(fetchGoogle.mock.calls.every(([, request]) => request?.method !== 'PATCH')).toBe(true)
  })

  it('rejects malformed catalogue rows without dropping them', async () => {
    mockWorkspace()
    fetchGoogle.mockResolvedValueOnce(json({ valueRanges: [
      { values: [['id', 'sourceId', 'sourceLabel', 'exportedAt', 'manifestFileId', 'manifestHash', 'contentHash', 'sessions', 'samples', 'bytes'], ['broken']] },
      { values: [['id', 'sourceId', 'parents', 'createdAt', 'theme', 'sidebar', 'statsPreferences', 'victronAdvertisementKey']] },
    ] }))
    await expect(remote.readCatalog(workspace, signal)).rejects.toThrow()
  })

  it('passes an already cancelled operation without making a request', async () => {
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(googleRequest('https://www.googleapis.com/drive/v3/files', cancelled.signal)).rejects.toThrow()
    expect(fetchGoogle).not.toHaveBeenCalled()
  })
})
