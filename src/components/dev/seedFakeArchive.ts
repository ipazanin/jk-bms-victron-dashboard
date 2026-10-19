import type { HistoryBrowser } from '../../application/history/historyBrowser'
import { MAX_RENDER_WINDOW_MS } from '../../application/history/port'
import type { HistoryStore, SessionClosure } from '../../application/history/port'
import { loadAdvertisementKey } from '../../application/storage'
import { PackChunkBuilder, SolarChunkBuilder } from '../../domain/history/columns'
import type { ChunkOrigin } from '../../domain/history/columns'
import {
  groupKeyFor,
  packDefaultLabel,
  packDeviceKeyFor,
  solarDefaultLabel,
  solarDeviceKeyFor,
} from '../../domain/history/identity'
import { MAX_PAIRING_AGE_MS } from '../../domain/history/join'
import { recomputeAccount } from '../../domain/history/ledger'
import { packSampleOf, solarSampleOf } from '../../domain/history/samples'
import { CHUNK_LAYOUT_VERSION, SAMPLE_INTERVAL_MS } from '../../domain/history/types'
import type {
  DeviceKey,
  PackChunk,
  PackSample,
  SessionEndReason,
  SessionId,
  SessionRecord,
  SolarChunk,
  SolarSample,
} from '../../domain/history/types'
import { SNAPSHOT_SCHEMA_VERSION } from '../../domain/schemaVersion'
import type { PlaybackFixture } from '../../infrastructure/ble/fake/fixture/PlaybackFixture'
import type { PlaybackScenario } from '../../infrastructure/ble/fake/fixture/PlaybackScenario'
import { loadPlaybackFixture } from '../../infrastructure/ble/fake/fixture/loadPlaybackFixture'
import { openArchiveChannel } from '../../infrastructure/history/archiveChannel'
import { FAKE_ARCHIVE_NAME } from '../../infrastructure/history/fakeArchiveName'
import { abortFailure } from '../../infrastructure/history/idb'

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

const NOON_HOUR = 12

const OLDEST_WATCH = 'fake-seed-oldest'
const INTERRUPTED_WATCH = 'fake-seed-interrupted'
const RESUMED_WATCH = 'fake-seed-resumed'
const TRIMMED_WATCH = 'fake-seed-trimmed'
const OVERLONG_WATCH = 'fake-seed-overlong'
const SILENT_WATCH = 'fake-seed-silent'

const SEED_WRITER = 'fake-seed'

const OLDEST_DAYS_BACK = 42

const OLDEST_STARTS_BEFORE_NOON_MS = MS_PER_HOUR
const INTERRUPTED_DAYS_BACK = 5
const TRIMMED_DAYS_BACK = 3
const SILENT_DAYS_BACK = 1

const SILENT_LINK_MS = 40_000

const OVERLONG_SPAN_MS = MAX_RENDER_WINDOW_MS + 6 * MS_PER_HOUR

const TRIMMED_HEAD_MS = 100 * MS_PER_MINUTE

const RESUME_GAP_MS = 90_000

const STRETCH_GAP_MS = MS_PER_HOUR

interface SeededWatch {
  readonly id: SessionId
  readonly startedAt: number
  readonly endReason: SessionEndReason

  readonly stretchesFrom: readonly number[]

  readonly retainedFrom: number | null
  readonly continues: SessionId | null

  readonly foreignLayout: boolean
}

export async function seedFakeArchive(store: HistoryStore, now: number): Promise<void> {
  const fixture = await loadPlaybackFixture()
  const solarDeviceKey = await seededSolarDeviceKey()
  const watches = seededWatches(now, fixture)

  for (const watch of watches) {
    await store.deleteSession(watch.id)
  }
  for (const watch of watches) await fileWatch(store, watch, fixture, solarDeviceKey)
  await fileDevices(store, watches, fixture, solarDeviceKey, now)

  announceArchiveChanged()
}

export async function dropViewedSession(
  store: HistoryStore,
  browser: HistoryBrowser,
): Promise<void> {
  const held = browser.loaded.value
  if (held === null) {
    throw new Error('Open a stored session first — there is none on screen to drop.')
  }

  await store.deleteSession(held.record.id)

  await browser.loadSession(held.record.id, held.window)
  announceArchiveChanged()
}

export async function wipeFakeArchive(store: HistoryStore): Promise<void> {
  store.close()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(FAKE_ARCHIVE_NAME)
    request.addEventListener('success', () => resolve(), { once: true })
    request.addEventListener(
      'error',
      (event) => {
        event.preventDefault()
        reject(request.error ?? abortFailure('The fake archive would not delete.'))
      },
      { once: true },
    )

    request.addEventListener('blocked', () => resolve(), { once: true })
  })
  window.location.reload()
}

function seededWatches(now: number, fixture: PlaybackFixture): readonly SeededWatch[] {
  const stretchMs = recordedStretchMs(fixture)

  const oldestFrom =
    localNoonOnTheDayOf(now - OLDEST_DAYS_BACK * MS_PER_DAY) - OLDEST_STARTS_BEFORE_NOON_MS
  const interruptedFrom = now - INTERRUPTED_DAYS_BACK * MS_PER_DAY
  const resumedFrom = interruptedFrom + stretchMs + RESUME_GAP_MS
  const trimmedFrom = now - TRIMMED_DAYS_BACK * MS_PER_DAY
  const silentFrom = now - SILENT_DAYS_BACK * MS_PER_DAY

  const overlongEndsAt = now - 2 * MS_PER_HOUR
  const overlongFrom = overlongEndsAt - OVERLONG_SPAN_MS

  return [
    {
      id: OLDEST_WATCH,
      startedAt: oldestFrom,
      endReason: 'user-disconnect',
      stretchesFrom: [oldestFrom, oldestFrom + stretchMs + STRETCH_GAP_MS],
      retainedFrom: null,
      continues: null,
      foreignLayout: true,
    },
    {
      id: INTERRUPTED_WATCH,
      startedAt: interruptedFrom,
      endReason: 'abandoned',
      stretchesFrom: [interruptedFrom],
      retainedFrom: null,
      continues: null,
      foreignLayout: false,
    },
    {
      id: RESUMED_WATCH,
      startedAt: resumedFrom,
      endReason: 'user-disconnect',
      stretchesFrom: [resumedFrom],
      retainedFrom: null,
      continues: INTERRUPTED_WATCH,
      foreignLayout: false,
    },
    {
      id: TRIMMED_WATCH,
      startedAt: trimmedFrom,
      endReason: 'stalled',
      stretchesFrom: [trimmedFrom + TRIMMED_HEAD_MS],
      retainedFrom: trimmedFrom + TRIMMED_HEAD_MS,
      continues: null,
      foreignLayout: false,
    },
    {
      id: OVERLONG_WATCH,
      startedAt: overlongFrom,
      endReason: 'link-lost',
      stretchesFrom: [overlongFrom, overlongEndsAt - stretchMs],
      retainedFrom: null,
      continues: null,
      foreignLayout: false,
    },
    {
      id: SILENT_WATCH,
      startedAt: silentFrom,
      endReason: 'link-lost',
      stretchesFrom: [],
      retainedFrom: null,
      continues: null,
      foreignLayout: false,
    },
  ]
}

async function fileWatch(
  store: HistoryStore,
  watch: SeededWatch,
  fixture: PlaybackFixture,
  solarDeviceKey: DeviceKey | null,
): Promise<void> {
  if (watch.stretchesFrom.length === 0) return fileSilentWatch(store, watch, fixture)

  const scenario = recordedScenario(fixture)
  const pack = watch.stretchesFrom.flatMap((from) =>
    onePerSecond(scenario.pack).map((frame) => packSampleOf(frame.battery, from + frame.atMs)),
  )
  const solar = watch.stretchesFrom.flatMap((from) =>
    onePerSecond(scenario.solar).map((frame) =>
      solarSampleOf(frame.reading, frame.rssi, from + frame.atMs),
    ),
  )

  const packChunks = packChunksOf(watch, pack)
  const solarChunks = solarChunksOf(watch, solar)
  const packDeviceKey = packDeviceKeyFor(fixture.device, null)
  const account = recomputeAccount(pack, solar, MAX_PAIRING_AGE_MS)
  const endedAt = lastSampleAt(pack, solar)

  const closure: SessionClosure = {
    endedAt,
    endReason: watch.endReason,
    heartbeatAt: endedAt,
    packSamples: pack.length,
    solarSamples: solar.length,
    packChunks: packChunks.length,
    solarChunks: solarChunks.length,
    droppedChunks: 0,
    coverage: account.coverage,
    ledger: account.ledger,
    entries: [
      { at: watch.startedAt, kind: 'begin', level: 'neutral', text: 'Session begins' },
      { at: endedAt, kind: 'end', level: 'neutral', text: 'Session ends' },
    ],
    packDeviceKey,
    solarDeviceKey,
    groupKey: groupKeyFor(packDeviceKey, solarDeviceKey),
    deviceInfo: fixture.device,
    settings: fixture.settings,
    finalBattery: scenario.pack[scenario.pack.length - 1].battery,
    finalSolar: scenario.solar[scenario.solar.length - 1].reading,
  }

  const record: SessionRecord = {
    ...closure,
    id: watch.id,
    schema: SNAPSHOT_SCHEMA_VERSION,
    writerId: SEED_WRITER,
    state: 'open',
    startedAt: watch.startedAt,
    endedAt: null,
    endReason: null,
    sealedSamples: 0,
    retainedFrom: watch.retainedFrom,
    continues: watch.continues,
  }

  await store.openSession(record)
  for (const chunk of packChunks) await store.commitChunk(chunk, closure)
  for (const chunk of solarChunks) await store.commitChunk(chunk, closure)
  await store.closeSession(watch.id, closure)
}

async function fileSilentWatch(
  store: HistoryStore,
  watch: SeededWatch,
  fixture: PlaybackFixture,
): Promise<void> {
  const packDeviceKey = packDeviceKeyFor(fixture.device, null)
  const account = recomputeAccount([], [], MAX_PAIRING_AGE_MS)
  const endedAt = watch.startedAt + SILENT_LINK_MS

  const closure: SessionClosure = {
    endedAt,
    endReason: watch.endReason,
    heartbeatAt: endedAt,
    packSamples: 0,
    solarSamples: 0,
    packChunks: 0,
    solarChunks: 0,
    droppedChunks: 0,
    coverage: account.coverage,
    ledger: account.ledger,
    entries: [
      { at: watch.startedAt, kind: 'begin', level: 'neutral', text: 'Session begins' },
      { at: endedAt, kind: 'end', level: 'neutral', text: 'Session ends' },
    ],
    packDeviceKey,

    solarDeviceKey: null,
    groupKey: groupKeyFor(packDeviceKey, null),

    deviceInfo: fixture.device,
    settings: fixture.settings,
    finalBattery: null,
    finalSolar: null,
  }

  const record: SessionRecord = {
    ...closure,
    id: watch.id,
    schema: SNAPSHOT_SCHEMA_VERSION,
    writerId: SEED_WRITER,
    state: 'open',
    startedAt: watch.startedAt,
    endedAt: null,
    endReason: null,
    sealedSamples: 0,
    retainedFrom: watch.retainedFrom,
    continues: watch.continues,
  }

  await store.openSession(record)
  await store.closeSession(watch.id, closure)
}

async function fileDevices(
  store: HistoryStore,
  watches: readonly SeededWatch[],
  fixture: PlaybackFixture,
  solarDeviceKey: DeviceKey | null,
  now: number,
): Promise<void> {
  const firstSeenAt = Math.min(...watches.map((watch) => watch.startedAt))
  const packDeviceKey = packDeviceKeyFor(fixture.device, null)

  if (packDeviceKey !== null) {
    await store.upsertDevice({
      key: packDeviceKey,
      kind: 'pack',
      defaultLabel: packDefaultLabel(fixture.device, null),
      userLabel: null,
      model: fixture.device.model,
      serialNumber: fixture.device.serialNumber,
      hardwareVersion: fixture.device.hardwareVersion,
      softwareVersion: fixture.device.softwareVersion,
      firstSeenAt,
      lastSeenAt: now,

      sessionCount: watches.length,
      packUtcOffsetMinutes: null,
      packClockAheadSeconds: null,
    })
  }

  if (solarDeviceKey !== null) {
    await store.upsertDevice({
      key: solarDeviceKey,
      kind: 'solar',

      defaultLabel: solarDefaultLabel(null),
      userLabel: null,
      model: null,
      serialNumber: null,
      hardwareVersion: null,
      softwareVersion: null,
      firstSeenAt,
      lastSeenAt: now,
      sessionCount: watches.length,
      packUtcOffsetMinutes: null,
      packClockAheadSeconds: null,
    })
  }
}

async function seededSolarDeviceKey(): Promise<DeviceKey | null> {
  const keyHex = loadAdvertisementKey()
  return keyHex === '' ? null : solarDeviceKeyFor(keyHex)
}

function packChunksOf(watch: SeededWatch, samples: readonly PackSample[]): readonly PackChunk[] {
  const chunks: PackChunk[] = []
  let builder: PackChunkBuilder | null = null

  for (const sample of samples) {
    if (builder !== null && builder.append(sample, sample.at)) continue
    if (builder !== null) chunks.push(builder.seal())
    builder = new PackChunkBuilder(originOf(watch.id, chunks.length, sample.at))
    builder.append(sample, sample.at)
  }
  if (builder !== null) chunks.push(builder.seal())

  if (!watch.foreignLayout || chunks.length === 0) return chunks
  return [{ ...chunks[0], layout: CHUNK_LAYOUT_VERSION + 1 }, ...chunks.slice(1)]
}

function solarChunksOf(watch: SeededWatch, samples: readonly SolarSample[]): readonly SolarChunk[] {
  const chunks: SolarChunk[] = []
  let builder: SolarChunkBuilder | null = null

  for (const sample of samples) {
    if (builder !== null && builder.append(sample, sample.at)) continue
    if (builder !== null) chunks.push(builder.seal())
    builder = new SolarChunkBuilder(originOf(watch.id, chunks.length, sample.at))
    builder.append(sample, sample.at)
  }
  if (builder !== null) chunks.push(builder.seal())
  return chunks
}

function originOf(sessionId: SessionId, seq: number, baseAt: number): ChunkOrigin {
  return { sessionId, seq, baseAt, baseMonotonic: baseAt }
}

function onePerSecond<Frame extends { readonly atMs: number }>(
  frames: readonly Frame[],
): readonly Frame[] {
  const kept: Frame[] = []
  let lastAtMs = Number.NEGATIVE_INFINITY
  for (const frame of frames) {
    if (frame.atMs - lastAtMs < SAMPLE_INTERVAL_MS) continue
    kept.push(frame)
    lastAtMs = frame.atMs
  }
  return kept
}

function localNoonOnTheDayOf(at: number): number {
  const noon = new Date(at)
  noon.setHours(NOON_HOUR, 0, 0, 0)
  return noon.getTime()
}

function recordedScenario(fixture: PlaybackFixture): PlaybackScenario {
  return fixture.scenarios[0]
}

function recordedStretchMs(fixture: PlaybackFixture): number {
  const scenario = recordedScenario(fixture)
  const pack = onePerSecond(scenario.pack)
  const solar = onePerSecond(scenario.solar)
  return Math.max(pack[pack.length - 1].atMs, solar[solar.length - 1].atMs)
}

function lastSampleAt(pack: readonly PackSample[], solar: readonly SolarSample[]): number {
  return Math.max(pack[pack.length - 1].at, solar[solar.length - 1].at)
}

function announceArchiveChanged(): void {
  const channel = openArchiveChannel(FAKE_ARCHIVE_NAME)
  channel.post('pruned')
  channel.close()
}
