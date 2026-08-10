/**
 * The stored rows an afternoon of playback cannot leave behind, and the one lever that takes a row
 * away again — both through the archive's own port.
 *
 * Everything the log says about a session it says from the row, and six of those sentences are
 * marks of time passing, of an archive being cut, or of a link that gave nothing: a watch longer
 * than the widest window the page will draw, a watch whose head pruning took, a watch that
 * continues one a killed tab left open, a watch old enough to date the landing line, a chunk
 * stamped with a layout no reader here has, and a watch holding no sample at all. Three minutes of
 * captured frames produce none of them, and waiting six weeks for the last one is not a development
 * loop.
 *
 * Written through `upsertDevice`, `openSession`, `commitChunk` and `closeSession` rather than into
 * the object stores, so a seeded row is one the adapter's own seals, merges and counters produced.
 * Two operations cannot be expressed that way and say so in their names: the sample counter, which
 * no port method moves without two million real samples behind it, and the wipe.
 *
 * The silent watch is the one row here that no recording would leave behind. A session under
 * `MIN_SESSION_SAMPLES` is deleted on finish rather than closed, and an abandoned one that sealed
 * nothing is evicted on the next open, so the recorder can neither write nor keep it — while the
 * store keeps whatever row it is handed, which is what makes the sentence the session view holds
 * for that state reachable at all.
 *
 * The samples are the ones the fake radios replay, thinned to the recorder's own gate of one a
 * second. Nothing here invents a reading.
 */

import type { HistoryBrowser } from '../../application/history/historyBrowser'
import { MAX_RENDER_WINDOW_MS } from '../../application/history/port'
import type { HistoryStore, SessionClosure } from '../../application/history/port'
import { loadAdvertisementKey } from '../../application/storage'
import { MAX_TOTAL_SAMPLES, PRUNE_TARGET_RATIO } from '../../domain/history/budget'
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
  HistoryMeta,
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
import { abortFailure, requestAsPromise, runTransaction } from '../../infrastructure/history/idb'
import {
  DATABASE_VERSION,
  META,
  TOTALS_KEY,
  applySchema,
} from '../../infrastructure/history/IdbHistoryStore'

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

/** The hour a row's clock band is anchored on, so a watch crossing it is one the band cannot hold. */
const NOON_HOUR = 12

/**
 * Ids that stay the same across seedings, so running the control twice replaces its own rows rather
 * than filling the log with copies of them.
 */
const OLDEST_WATCH = 'fake-seed-oldest'
const INTERRUPTED_WATCH = 'fake-seed-interrupted'
const RESUMED_WATCH = 'fake-seed-resumed'
const TRIMMED_WATCH = 'fake-seed-trimmed'
const OVERLONG_WATCH = 'fake-seed-overlong'
const SILENT_WATCH = 'fake-seed-silent'

/** No tab wrote these, and a row claiming one is a row the stale-heartbeat sweep would believe. */
const SEED_WRITER = 'fake-seed'

/** Six weeks is outside every range preset, which is the whole job of the row it dates. */
const OLDEST_DAYS_BACK = 42

/**
 * How far before local noon the oldest watch starts, so that it runs across noon.
 *
 * A row draws its watch on one local day anchored at noon, and clips anything reaching outside it.
 * Crossing noon while staying under a day is therefore the only way to a row that says a window was
 * cut without also being a watch longer than a day, and an hour before noon is enough: this watch
 * runs a little over one, from its first stretch through the hour of silence to its second.
 *
 * Anchored rather than measured back from the caller's clock, which is what the other five are.
 * Placed a whole number of days back, whether it crossed noon would depend on the hour the control
 * happened to be pressed.
 */
const OLDEST_STARTS_BEFORE_NOON_MS = MS_PER_HOUR
const INTERRUPTED_DAYS_BACK = 5
const TRIMMED_DAYS_BACK = 3
const SILENT_DAYS_BACK = 1

/**
 * How long the link stood with nothing coming over it. Long enough that the row reads as a watch
 * somebody sat through rather than as a connection that never landed.
 */
const SILENT_LINK_MS = 40_000

/** Stated against the cut rather than as a figure, so it cannot quietly stop exceeding it. */
const OVERLONG_SPAN_MS = MAX_RENDER_WINDOW_MS + 6 * MS_PER_HOUR

/** What pruning took off the head of the trimmed watch, and therefore what its row has to declare. */
const TRIMMED_HEAD_MS = 100 * MS_PER_MINUTE

/** Long enough to be an interruption a tab was killed in, short enough to read as the same watch. */
const RESUME_GAP_MS = 90_000

/** Past `MAX_CHUNK_SPAN_MS`, so a second stretch always opens a chunk of its own. */
const STRETCH_GAP_MS = MS_PER_HOUR

/**
 * Between the mark pruning aims for and the cap it is measured against, so the storage line reports
 * the archive as near the limit without the next commit evicting every session to get under it.
 */
const NEAR_CAPACITY_SAMPLES = Math.round((MAX_TOTAL_SAMPLES * (1 + PRUNE_TARGET_RATIO)) / 2)

/**
 * One watch to seed: when it ran, what it recorded, and the one thing about it a playback session
 * cannot be.
 *
 * A description rather than a row. The ledger, the coverage and every counter are folded from the
 * samples this places, so nothing here can state a figure the stored rows do not support.
 */
interface SeededWatch {
  readonly id: SessionId
  readonly startedAt: number
  readonly endReason: SessionEndReason
  /** Wall clock each recorded stretch begins at. The silence between two of them is a real gap, and
   *  no stretch at all is a watch that recorded nothing. */
  readonly stretchesFrom: readonly number[]
  /** Where surviving data starts once pruning cut the head, and null when nothing was cut. */
  readonly retainedFrom: number | null
  readonly continues: SessionId | null
  /** Stamps the first pack chunk with a layout no build reads, so the session declares one. */
  readonly foreignLayout: boolean
}

/**
 * Fills the fake archive with those rows, replacing whatever the last seeding left.
 *
 * `now` is the caller's clock and not this module's, so a page whose clock has been pushed forward
 * seeds a log that agrees with the one it is showing.
 */
export async function seedFakeArchive(store: HistoryStore, now: number): Promise<void> {
  const fixture = await loadPlaybackFixture()
  const solarDeviceKey = await seededSolarDeviceKey()
  const watches = seededWatches(now, fixture)

  for (const watch of watches) {
    // Deleted rather than merged over. `openSession` puts a row counting no sealed rows at all,
    // while the chunks the last seeding sealed are still on disk and still counted by the archive's
    // own total — so the two would disagree by exactly one seeding, permanently.
    await store.deleteSession(watch.id)
  }
  for (const watch of watches) await fileWatch(store, watch, fixture, solarDeviceKey)
  await fileDevices(store, watches, fixture, solarDeviceKey, now)

  announceArchiveChanged()
}

/**
 * Takes the session on screen out of the archive underneath the view that is holding it.
 *
 * `noteViewing` exists to stop pruning doing exactly this, and inside one tab it works — which is
 * why no amount of clicking around reaches the sentence a dropped session prints. A second tab
 * prunes against stored fields alone and cannot be told what this one is reading, so the reader
 * still has to survive a read that comes back with nothing, and this is that read.
 *
 * Deleted through the port, then asked for again through the same call the view makes when it pans a
 * session too long to hold at once. The second half is not decoration: the read model reports a
 * session dropped when a read it asked for answers null, and a delete on its own leaves whatever was
 * already hydrated on screen with nothing to prompt another look at disk.
 */
export async function dropViewedSession(
  store: HistoryStore,
  browser: HistoryBrowser,
): Promise<void> {
  const held = browser.loaded.value
  if (held === null) {
    throw new Error('Open a stored session first — there is none on screen to drop.')
  }

  await store.deleteSession(held.record.id)
  // Asked for with the window already on screen. Without one the model recognises a settled session
  // and answers from what it holds, which is the one path that never reaches the store.
  await browser.loadSession(held.record.id, held.window)
  announceArchiveChanged()
}

/**
 * Moves the archive's sample counter to just under the cap, which is the one figure on the storage
 * line playback never reaches: it counts rows in sealed chunks, and two million of them is two
 * hundred and seventy hours of recording.
 *
 * The one write here that goes around the port. There is no method that moves the counter without
 * the samples behind it and there should not be — a store that let a writer assert its own total
 * would let two tabs disagree about the archive with nothing able to arbitrate.
 *
 * It lasts until the next load. Opening the archive recovers it, and recovery recomputes the counter
 * from the rows every session holds, which is exactly the invariant this breaks on purpose.
 */
export async function fillSampleCounterToNearCapacity(now: number): Promise<void> {
  const database = await openFakeArchiveDirectly()
  try {
    await runTransaction(database, [META], 'readwrite', async (transaction) => {
      const meta = transaction.objectStore(META)
      const stored = await requestAsPromise<HistoryMeta | undefined>(meta.get(TOTALS_KEY))
      const filled: HistoryMeta = {
        key: TOTALS_KEY,
        schema: stored?.schema ?? SNAPSHOT_SCHEMA_VERSION,
        createdAt: stored?.createdAt ?? now,
        lastPrunedAt: stored?.lastPrunedAt ?? null,
        totalSamples: NEAR_CAPACITY_SAMPLES,
      }
      await requestAsPromise(meta.put(filled))
    })
  } finally {
    database.close()
  }
  announceArchiveChanged()
}

/**
 * Deletes the fake archive and reloads onto an empty one.
 *
 * The connection is closed first and the delete is waited on: a delete issued underneath a live
 * connection is blocked until that connection goes, which on a page about to reload means racing
 * the reload's own open against it.
 *
 * Waited on here rather than through `requestAsPromise`, which settles on success or error only. A
 * delete the browser reports as blocked sends neither, and this one is finished as far as its caller
 * is concerned the moment the document goes.
 */
export async function wipeFakeArchive(store: HistoryStore): Promise<void> {
  store.close()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(FAKE_ARCHIVE_NAME)
    request.addEventListener('success', () => resolve(), { once: true })
    request.addEventListener(
      'error',
      (event) => {
        // Cancelled, or the failure is reported twice: once to the caller below and once to the
        // page as an uncaught error nobody threw.
        event.preventDefault()
        reject(request.error ?? abortFailure('The fake archive would not delete.'))
      },
      { once: true },
    )
    // Something else on this origin still holds it open. Reloading is what lets go, so this is not
    // a failure to report — the delete completes the moment this document does.
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
  // Placed from its end backwards. The last stretch has to sit inside the window the view will
  // draw and the first one outside it, or there is nothing on screen to say a window was cut.
  const overlongEndsAt = now - 2 * MS_PER_HOUR
  const overlongFrom = overlongEndsAt - OVERLONG_SPAN_MS

  return [
    {
      // Dates the landing line, and carries the unreadable chunk: a layout change strands the
      // oldest chunks on disk and never the newest, so this is the watch one belongs in.
      id: OLDEST_WATCH,
      startedAt: oldestFrom,
      endReason: 'user-disconnect',
      stretchesFrom: [oldestFrom, oldestFrom + stretchMs + STRETCH_GAP_MS],
      retainedFrom: null,
      continues: null,
      foreignLayout: true,
    },
    {
      // The tab was killed here, which is what leaves a session for the next load to continue.
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
      // The head is gone, so the recording starts where the retained data starts and the row is
      // what says how much of the watch is missing from in front of it.
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
      // The pack answered its handshake and never sent a measurement. Nothing was recorded, so the
      // row is the whole of what the log has to work from.
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

/**
 * The watch that recorded nothing: the pack answered its handshake, no measurement ever followed,
 * and the link went quiet.
 *
 * Opened and closed with no chunk in between, which is the whole of it — the session view reads the
 * row's own two sample counters and not the chunks, and a row that committed nothing leaves them at
 * zero. The ledger and the coverage are folded from the same empty streams every other row folds
 * from, so neither of them states a figure this watch did not measure.
 *
 * Closed rather than left open. Recovery evicts an abandoned row that sealed nothing, so an open one
 * would be gone by the next load; a closed one is a row recovery walks past.
 */
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
    // Nothing was listening for a controller: this watch is a pack link and only a pack link.
    solarDeviceKey: null,
    groupKey: groupKeyFor(packDeviceKey, null),
    // The two frames a pack hands over before its first measurement are what it did say. The final
    // readings stay null because nothing ever measured one.
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

/**
 * The device rows the seeded sessions group under.
 *
 * The owner's own three answers are never asserted: `userLabel` and the pack's two clock fields are
 * kept by the store across a merge, and a seeding that supplied them would put a default back over
 * a rename.
 */
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
      // Merged with a maximum, so a seeding never takes a count the radios have climbed past back
      // down.
      sessionCount: watches.length,
      packUtcOffsetMinutes: null,
      packClockAheadSeconds: null,
    })
  }

  if (solarDeviceKey !== null) {
    await store.upsertDevice({
      key: solarDeviceKey,
      kind: 'solar',
      // The model id is the whole of what a controller nothing connects to says about itself, and
      // no seeded row heard one.
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

/**
 * The controller's key, derived from the throwaway advertisement key playback seeds, so a seeded
 * session files under exactly the controller the live radios file under. Null until a key is
 * stored, and the seeded sessions are then pack-only — which is a true statement about them.
 */
async function seededSolarDeviceKey(): Promise<DeviceKey | null> {
  const keyHex = loadAdvertisementKey()
  return keyHex === '' ? null : solarDeviceKeyFor(keyHex)
}

/**
 * Chunks the way the recorder seals them: a new one whenever the builder refuses the row it is
 * offered, which the hour of silence between two stretches guarantees it will.
 *
 * The unreadable one is the first, and only the first, so the session still holds data it can plot
 * beside the stretch it has to declare it cannot.
 */
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

/**
 * A chunk's two bases, at the same instant. A seeded row has no monotonic clock behind it, and the
 * stored drift is then zero — which is the true statement about a wall clock that was never stepped
 * under these rows.
 */
function originOf(sessionId: SessionId, seq: number, baseAt: number): ChunkOrigin {
  return { sessionId, seq, baseAt, baseMonotonic: baseAt }
}

/**
 * Thins a captured stream to the recorder's own gate. The radios report about four times a second
 * and the archive holds one row a second, so a stretch that kept every frame would be four times
 * denser than anything a recording could contain.
 */
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

/** Noon of whatever local day an instant falls in, which is where a row's band is anchored. */
function localNoonOnTheDayOf(at: number): number {
  const noon = new Date(at)
  noon.setHours(NOON_HOUR, 0, 0, 0)
  return noon.getTime()
}

/** The steady condition, which is what an unattended watch mostly is. */
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

/**
 * A connection of this module's own, for the one write that cannot go through the port.
 *
 * Opened at the schema's version and upgraded through the adapter's own function. Opening with no
 * version instead is the trap here: on a database that does not exist yet it does not fail, it
 * creates an empty one at version one — and the archive's real open then upgrades from one, skips
 * the block that builds the first five stores, and the log is left permanently unable to hold a
 * session.
 *
 * Waited on here rather than through `requestAsPromise` for the same reason the wipe is. A tab left
 * over from a build at an older schema is enough to produce a blocked open, and this open carries no
 * ceiling to give up under — so it is refused outright, rather than hanging with nothing on screen
 * to say why.
 */
function openFakeArchiveDirectly(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(FAKE_ARCHIVE_NAME, DATABASE_VERSION)
    let refused = false

    request.addEventListener('upgradeneeded', (event) => {
      applySchema(request.result, (event as IDBVersionChangeEvent).oldVersion)
    })
    request.addEventListener(
      'blocked',
      () => {
        refused = true
        reject(new Error('Another tab is holding the fake archive at an older schema.'))
      },
      { once: true },
    )
    request.addEventListener(
      'success',
      () => {
        // An open cannot be cancelled, so the upgrade still runs the moment the other tab lets go
        // and hands back a connection nobody is waiting for any more. Left open, that connection is
        // itself what blocks the next schema upgrade in every other tab on this origin.
        if (refused) request.result.close()
        else resolve(request.result)
      },
      { once: true },
    )
    request.addEventListener(
      'error',
      (event) => {
        event.preventDefault()
        reject(request.error ?? abortFailure('The fake archive would not open.'))
      },
      { once: true },
    )
  })
}

/**
 * Tells this tab's own store that the archive changed.
 *
 * A channel never delivers to the object that posted, so the store's own writes are silent to the
 * page that made them and the read model would go on showing what it last listed. A seeding is
 * another writer as far as the views are concerned, and this is how another writer says so.
 */
function announceArchiveChanged(): void {
  const channel = openArchiveChannel(FAKE_ARCHIVE_NAME)
  channel.post('pruned')
  channel.close()
}
