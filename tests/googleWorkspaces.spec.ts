import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGoogleWorkspace, listGoogleWorkspaces, pickGoogleWorkspace, trashGoogleWorkspace, validateGoogleWorkspace } from '../src/infrastructure/google/googleWorkspaces'
import { pickGoogleFolder } from '../src/infrastructure/google/googlePicker'
import { googleRequest } from '../src/infrastructure/google/googleRequest'

vi.mock('../src/infrastructure/google/googlePicker', () => ({ pickGoogleFolder: vi.fn() }))
vi.mock('../src/infrastructure/google/googleRequest', () => ({
  googleRequest: vi.fn(),
  jsonRequest: (method: string, body: unknown) => ({ method, body: JSON.stringify(body) }),
}))
const request = vi.mocked(googleRequest)
const signal = new AbortController().signal
const workspace = { id: 'archive-folder', folderId: 'archive-folder', name: 'Boat', version: 3 as const }
const folder = { id: workspace.id, name: workspace.name, mimeType: 'application/vnd.google-apps.folder',
  appProperties: { shuntCloud: '1', shuntRole: 'workspace', shuntVersion: '3' } }
const destination = { id: 'destination', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } }
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => vi.resetAllMocks())

describe('Google workspace folders', () => {
  it.each(['destination', 'root'])('creates an owned folder explicitly under %s', async (parentId) => {
    request.mockResolvedValueOnce(json(destination)).mockResolvedValueOnce(json({ id: workspace.id }))
    await expect(createGoogleWorkspace(' Boat ', parentId, signal)).resolves.toEqual(workspace)
    expect(request).toHaveBeenCalledTimes(2)
    expect(JSON.parse(request.mock.calls[1]![2]!.body as string)).toEqual({
      name: 'Boat', mimeType: 'application/vnd.google-apps.folder', parents: [parentId],
      appProperties: { shuntCloud: '1', shuntRole: 'workspace', shuntVersion: '3' },
    })
  })

  it.each([
    { ...destination, capabilities: { canAddChildren: false } },
    { ...destination, trashed: true },
    { ...destination, mimeType: 'text/plain' },
  ])('does not create or fall back to root for an invalid destination', async (parent) => {
    request.mockResolvedValueOnce(json(parent))
    await expect(createGoogleWorkspace('Boat', 'destination', signal)).rejects.toThrow('where you can create files')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not create or fall back to root when the destination disappeared', async () => {
    request.mockRejectedValueOnce(new Error('Not found'))
    await expect(createGoogleWorkspace('Boat', 'destination', signal)).rejects.toThrow('Not found')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('makes no request if creation was cancelled', async () => {
    const cancelled = AbortSignal.abort()
    await expect(createGoogleWorkspace('Boat', 'destination', cancelled)).rejects.toMatchObject({ name: 'AbortError' })
    expect(request).not.toHaveBeenCalled()
  })

  it('does not create after destination validation is cancelled', async () => {
    const controller = new AbortController()
    request.mockImplementationOnce(async () => {
      controller.abort()
      return json(destination)
    })
    await expect(createGoogleWorkspace('Boat', 'destination', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does nothing when opening a folder is cancelled', async () => {
    vi.mocked(pickGoogleFolder).mockResolvedValue(null)
    await expect(pickGoogleWorkspace(signal)).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('opens a workspace after its folder moves', async () => {
    vi.mocked(pickGoogleFolder).mockResolvedValue({ id: workspace.id, name: workspace.name })
    request.mockResolvedValueOnce(json({ ...folder, parents: ['new-parent'] }))
    await expect(pickGoogleWorkspace(signal)).resolves.toEqual(workspace)
  })

  it('lists version 3 folders and legacy catalogs without duplicate legacy folders', async () => {
    request.mockResolvedValueOnce(json({ files: [folder, { ...folder, id: 'legacy-folder', appProperties: { shuntCloud: '1', shuntRole: 'workspace' } },
      { id: 'sheet', name: 'Legacy', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['legacy-folder'],
        appProperties: { shuntCloud: '1', shuntRole: 'catalog', shuntWorkspace: 'legacy-folder', shuntVersion: '2' } }] }))
    await expect(listGoogleWorkspaces(signal)).resolves.toEqual([workspace, { id: 'sheet', name: 'Legacy', folderId: 'legacy-folder', version: 2 }])
  })

  it.each([1, 2] as const)('opens a version %s legacy workspace through its folder and verifies its catalog', async (version) => {
    const legacyFolder = { ...folder, appProperties: { shuntCloud: '1', shuntRole: 'workspace' } }
    const catalog = { id: 'sheet', name: 'Legacy', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [folder.id],
      appProperties: { shuntCloud: '1', shuntRole: 'catalog', shuntWorkspace: folder.id, shuntVersion: String(version) } }
    vi.mocked(pickGoogleFolder).mockResolvedValue({ id: folder.id, name: 'Legacy' })
    request.mockResolvedValueOnce(json(legacyFolder)).mockResolvedValueOnce(json({ files: [catalog] }))
      .mockResolvedValueOnce(json(catalog)).mockResolvedValueOnce(json(legacyFolder))
      .mockResolvedValueOnce(json({ valueRanges: [{ values: [['format', 'shunt-cloud'], ['version', version], ['folderId', folder.id]] }] }))
    await expect(pickGoogleWorkspace(signal)).resolves.toEqual({ id: 'sheet', name: 'Legacy', folderId: folder.id, ...(version === 2 ? { version: 2 } : {}) })
  })

  it('rejects a version 3 identity pointing at another folder', async () => {
    await expect(validateGoogleWorkspace({ ...workspace, folderId: 'destination' }, signal)).rejects.toThrow('identity')
    expect(request).not.toHaveBeenCalled()
  })

  it('never trashes an ordinary destination folder', async () => {
    request.mockResolvedValueOnce(json(destination))
    await expect(trashGoogleWorkspace({ ...workspace, id: destination.id, folderId: destination.id }, signal)).rejects.toThrow('invalid folder metadata')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects an ordinary folder when opening an archive', async () => {
    vi.mocked(pickGoogleFolder).mockResolvedValue({ id: destination.id, name: 'Destination' })
    request.mockResolvedValueOnce(json(destination))
    await expect(pickGoogleWorkspace(signal)).rejects.toThrow('not a Shunt archive')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('trashes only the verified workspace folder after it has moved', async () => {
    request.mockResolvedValueOnce(json({ ...folder, parents: ['destination'] })).mockResolvedValueOnce(json({}))
    await trashGoogleWorkspace(workspace, signal)
    expect(request.mock.calls[1]![0]).toBe('https://www.googleapis.com/drive/v3/files/archive-folder')
    expect(JSON.parse(request.mock.calls[1]![2]!.body as string)).toEqual({ trashed: true })
  })
})
