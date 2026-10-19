// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, nextTick, ref, shallowRef } from 'vue'
import type { App, Component } from 'vue'
import type { ArchiveSnapshot } from '../src/domain/backup/ArchiveSnapshot'
import type { ArchiveSource } from '../src/domain/backup/ArchiveSource'
import type { ImportedArchive } from '../src/application/backup/ImportedArchive'
import { SECRET_PREFERENCE_KEY } from '../src/domain/backup/archivePreferences'
import { provideHistoryEnvironment } from '../src/application/history/historyBrowser'
import DataBackupPanel from '../src/components/backup/DataBackupPanel.vue'
import ArchiveSourceBar from '../src/components/backup/ArchiveSourceBar.vue'
import DeviceName from '../src/components/DeviceName.vue'
import StatsView from '../src/components/views/StatsView.vue'
import SessionRow from '../src/components/history/SessionRow.vue'
import LogView from '../src/components/history/LogView.vue'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { battery, deviceInfo, packChunk, packSamples, ringSnapshot, sessionRecord } from './support/samples'
import { capturedSolarSnapshot } from './support/solarHistoryFixture'

vi.mock('../src/application/backup/useArchiveWorkspace', () => ({
  useArchiveWorkspace: () => workspace,
}))

vi.mock('../src/application/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/application/telemetry')>()
  return {
    ...actual,
    useTelemetry: () => ({
      ...actual.useTelemetry(),
      battery: ref(battery({ cycleCount: 987654 })),
      device: ref(deviceInfo({ model: 'LOCAL ONLY BMS' })),
    }),
  }
})

const source = shallowRef<ArchiveSource | null>({ id: 'local', label: 'Laptop' })
const imported = shallowRef<readonly ImportedArchive[]>([])
const selectedSourceId = ref<string | null>(null)
const workspace = {
  source,
  imported,
  selectedSourceId,
  selected: computed(() => imported.value.find((archive) => archive.source.id === selectedSourceId.value) ?? null),
  readOnly: computed(() => selectedSourceId.value !== null),
  ready: ref(true),
  preview: shallowRef<readonly ArchiveSnapshot[]>([]),
  busy: ref(false),
  failure: ref<string | null>(null),
  notice: ref<string | null>(null),
  selectSource: vi.fn(),
  exportArchives: vi.fn(),
  previewImport: vi.fn(),
  applyImport: vi.fn(),
  applySelectedPreferences: vi.fn(),
  restoreSelectedArchive: vi.fn(),
  clearPreview: vi.fn(),
  cancel: vi.fn(),
}

let host: HTMLElement
let app: App | null = null

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  source.value = { id: 'local', label: 'Laptop' }
  imported.value = []
  selectedSourceId.value = null
  workspace.preview.value = []
  workspace.busy.value = false
  workspace.failure.value = null
  workspace.notice.value = null
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  app?.unmount()
  app = null
  host.remove()
  localStorage.clear()
})

async function mount(component: Component, props: Record<string, unknown> = {}): Promise<void> {
  app = createApp(component, props)
  app.mount(host)
  for (let turn = 0; turn < 12; turn += 1) await nextTick()
}

function snapshot(): ArchiveSnapshot {
  return {
    format: 'shunt-archive', version: 1, exportedAt: Date.UTC(2026, 9, 18),
    source: { id: 'boat', label: 'Boat tablet' },
    stores: {
      sessions: [sessionRecord()], chunks: [packChunk(packSamples(3), { sealed: false })],
      devices: [], meta: [], warnings: [], ringRecords: [], ringReads: [],
    },
    preferences: [{ key: SECRET_PREFERENCE_KEY, value: 'private-key' }],
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  if (found === undefined) throw new Error(`Missing button: ${label}`)
  return found
}

function selectSavedCopy(id = 'boat'): void {
  imported.value = [{ source: { id, label: 'Boat tablet' }, exportedAt: Date.UTC(2026, 9, 18), importedAt: Date.now(), preferences: [] }]
  selectedSourceId.value = id
}

describe('complete archive controls', () => {
  it('keeps the source picker on the displayed archive when a delayed switch fails', async () => {
    selectSavedCopy()
    selectedSourceId.value = null
    let finish: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { finish = resolve })
    workspace.selectSource.mockImplementationOnce(async () => {
      await pending
      workspace.failure.value = 'The imported archive could not be opened.'
    })
    await mount(ArchiveSourceBar)
    const picker = host.querySelector<HTMLSelectElement>('select')!
    picker.value = 'boat'
    picker.dispatchEvent(new Event('change'))
    await nextTick()
    const whilePending = picker.value
    finish!()
    await pending
    await nextTick()
    expect(whilePending).toBe('')
    expect(picker.value).toBe('')
    expect(selectedSourceId.value).toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('The imported archive could not be opened.')
  })

  it('changes the source picker only after a delayed source switch succeeds', async () => {
    selectSavedCopy()
    selectedSourceId.value = null
    let finish: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { finish = resolve })
    workspace.selectSource.mockImplementationOnce(async () => {
      await pending
      selectedSourceId.value = 'boat'
    })
    await mount(ArchiveSourceBar)
    const picker = host.querySelector<HTMLSelectElement>('select')!
    picker.value = 'boat'
    picker.dispatchEvent(new Event('change'))
    await nextTick()
    const whilePending = picker.value
    finish!()
    await pending
    await nextTick()
    expect(whilePending).toBe('')
    expect(picker.value).toBe('boat')
    expect(host.textContent).toContain('Read-only copy captured')
  })

  it('shows a source opening failure only once inside the backup panel', async () => {
    workspace.failure.value = 'The imported archive could not be opened.'
    await mount(DataBackupPanel)
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('The imported archive could not be opened.')
  })

  it('exports without Bluetooth and excludes the key unless explicitly selected', async () => {
    await mount(DataBackupPanel)
    expect(navigator.bluetooth).toBeUndefined()
    expect(button('Export this browser').disabled).toBe(false)
    button('Export this browser').click()
    expect(workspace.exportArchives).toHaveBeenLastCalledWith(false, false)

    const secret = host.querySelector<HTMLInputElement>('[data-testid="export-secret"]')!
    expect(secret.checked).toBe(false)
    secret.click()
    button('Export this browser').click()
    expect(workspace.exportArchives).toHaveBeenLastCalledWith(true, false)
  })

  it.each(['boat.json.gz', 'boat.json'])('previews %s before offering import', async (fileName) => {
    await mount(DataBackupPanel)
    expect(host.querySelector('[data-testid="apply-import"]')).toBeNull()
    const file = new File(['archive'], fileName)
    const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(picker, 'files', { value: [file], configurable: true })
    picker.dispatchEvent(new Event('change'))
    await nextTick()
    expect(workspace.previewImport).toHaveBeenCalledWith(file)
    expect(workspace.applyImport).not.toHaveBeenCalled()

    workspace.preview.value = [snapshot()]
    await nextTick()
    expect(host.textContent).toContain('Boat tablet')
    expect(host.textContent).toContain('Raw samples')
    expect(host.textContent).toContain('Hourly summaries')
    expect(host.textContent).toContain('Your current recordings and browser settings stay unchanged')
    expect(host.textContent).not.toContain('private-key')
    button('Import saved copies').click()
    expect(workspace.applyImport).toHaveBeenCalledOnce()
  })

  it('explains replacement of an existing saved source and leaves cancellation available', async () => {
    selectSavedCopy()
    workspace.preview.value = [snapshot()]
    await mount(DataBackupPanel)
    expect(host.textContent).toContain('This replaces the saved copy of this source')
    expect(host.textContent).toContain('Records from the two copies are not combined')
    button('Cancel import').click()
    expect(workspace.clearPreview).toHaveBeenCalledOnce()
    expect(workspace.applyImport).not.toHaveBeenCalled()
  })

  it('requires a separate key opt-in for settings and explicit confirmation for local restore', async () => {
    selectSavedCopy('local')
    await mount(DataBackupPanel)
    button('Apply saved settings').click()
    expect(workspace.applySelectedPreferences).toHaveBeenLastCalledWith(false)
    host.querySelector<HTMLInputElement>('[data-testid="settings-secret"]')!.click()
    button('Apply saved settings').click()
    expect(workspace.applySelectedPreferences).toHaveBeenLastCalledWith(true)
    expect(host.textContent).toContain("Current sources includes this browser's current history and other sources")
    expect(host.textContent).toContain('export that copy separately')
    expect(button('Restore history').disabled).toBe(true)
    const confirmation = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (checkbox) => checkbox.parentElement?.textContent?.includes("Replace this browser's current history"),
    )!
    confirmation.click()
    await nextTick()
    button('Restore history').click()
    expect(workspace.restoreSelectedArchive).toHaveBeenCalledOnce()
  })

  it('shows capture provenance and allows exporting imported sources without offering foreign local restore', async () => {
    selectSavedCopy()
    await mount(DataBackupPanel)
    expect(host.textContent).toContain('Read-only copy captured')
    expect(host.textContent).toContain('Sessions marked open were recording at capture')
    expect(host.textContent).not.toContain('Restore this browser’s history')
    expect([...host.querySelectorAll('button')].some((candidate) => candidate.textContent === 'Restore history')).toBe(false)
    button('Export selected source').click()
    expect(workspace.exportArchives).toHaveBeenLastCalledWith(false, false)
    button('Export current sources').click()
    expect(workspace.exportArchives).toHaveBeenLastCalledWith(false, true)
  })

  it('suppresses device renaming for an imported source', async () => {
    selectSavedCopy()
    await mount(DeviceName, { label: 'House bank', defaultLabel: 'JK BMS' })
    expect(host.querySelector('button')).toBeNull()
    expect(host.querySelector('input')).toBeNull()
  })

  it('keeps imported stats browsable while suppressing local telemetry and mutations', async () => {
    selectSavedCopy()
    const store = new MemoryHistoryStore()
    await store.appendRingSnapshot(ringSnapshot({ observedAt: Date.UTC(2026, 9, 18) }))
    await store.appendSolarHistory(capturedSolarSnapshot({ observedAt: Date.UTC(2026, 9, 18) }))
    provideHistoryEnvironment({ store, downloadJson: () => undefined })
    await mount(StatsView)
    expect(host.querySelector('[role="radio"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="stats-solar-yield"]')).not.toBeNull()
    expect(host.textContent).not.toContain('LOCAL ONLY BMS')
    expect(host.textContent).not.toContain('987654')
    expect(host.textContent).toContain('No device logbook was included in this saved copy')
    const labels = [...host.querySelectorAll('button')].map((candidate) => candidate.textContent?.trim())
    for (const forbidden of ['Read stored log', 'Read solar history', 'Confirm this zone', 'Pin as exact', 'Clear the pin', "Delete this pack's log"]) {
      expect(labels).not.toContain(forbidden)
    }
    const before = localStorage.getItem('shunt.statsPreferences')
    button('Month').click()
    await nextTick()
    expect(localStorage.getItem('shunt.statsPreferences')).toBe(before)
  })

  it('shows the imported source own remembered instruments and logbook', async () => {
    selectSavedCopy()
    imported.value = [{
      ...imported.value[0]!,
      preferences: [
        { key: 'shunt.rememberedSession', value: JSON.stringify({
          capturedAt: Date.UTC(2026, 9, 17),
          battery: battery({ cycleCount: 32101 }),
          device: deviceInfo({ model: 'ARCHIVE ONLY BMS' }),
        }) },
        { key: 'shunt.logbook', value: JSON.stringify({
          fetchedAt: Date.UTC(2026, 9, 17), uptimeSecondsAtFetch: 3600,
          events: [{ secondsSinceBoot: 1, code: 1, label: 'Saved boat event' }],
        }) },
      ],
    }]
    provideHistoryEnvironment({ store: new MemoryHistoryStore(), downloadJson: () => undefined })
    await mount(StatsView)
    expect(host.textContent).toContain('ARCHIVE ONLY BMS')
    expect(host.textContent).toContain('32101')
    expect(host.textContent).toContain('Saved boat event')
    expect(host.textContent).toContain('Saved with Boat tablet')
    expect(host.textContent).not.toContain('LOCAL ONLY BMS')
    expect(host.textContent).not.toContain('987654')
    expect(localStorage.getItem('shunt.rememberedSession')).toBeNull()
    expect(localStorage.getItem('shunt.logbook')).toBeNull()
  })

  it('does not describe imported history as subject to local recording eviction', async () => {
    selectSavedCopy()
    provideHistoryEnvironment({ store: new MemoryHistoryStore(), downloadJson: () => undefined })
    await mount(LogView)
    expect(host.textContent).not.toContain('oldest deleted first')
    expect(host.textContent).toContain('No sessions in this saved copy')
  })

  it('labels an imported open session as open at capture', async () => {
    selectSavedCopy()
    const recorded = sessionRecord()
    await mount(SessionRow, {
      listing: { record: recorded, device: null, label: 'House bank' },
      now: recorded.startedAt + 30_000,
    })
    expect(host.textContent).toContain('Open at capture · 00:00:30')
    expect(host.textContent).not.toContain('Recording')
  })

  it('does not offer pack reads from an imported source with only solar history', async () => {
    selectSavedCopy()
    const store = new MemoryHistoryStore()
    await store.appendSolarHistory(capturedSolarSnapshot())
    provideHistoryEnvironment({ store, downloadJson: () => undefined })
    await mount(StatsView)
    expect(host.textContent).toContain('This source contains solar history only')
    expect([...host.querySelectorAll('button')].some((candidate) => /Read stored log|Read solar history/.test(candidate.textContent ?? ''))).toBe(false)
  })
})
