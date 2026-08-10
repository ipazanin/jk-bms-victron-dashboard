/**
 * Distils the boat captures into the three fixtures the playback fake replays.
 *
 * The captures are gitignored raw device dumps; the fixtures are small, committed, and carry no
 * device identity. Everything here runs through the repo's own decoders rather than a second
 * transcription of the layouts, so an offset that moves in `src/domain` moves the fixture with it
 * and cannot leave the fake replaying a shape the app no longer reads.
 *
 * The live streams come out as decoded production types and the two stored histories as wire bytes,
 * and the split is deliberate. Decoding a live frame here is what strips the pack's identity out —
 * the frame carries its serial twice, so a fixture of hex would ship it. The stored histories stay
 * as bytes because the fake feeds them back through the real transports, which is what keeps a
 * receipt on screen from saying anything the frames do not support.
 *
 * No advertisement key is read and none is needed: the solar rows come from the plaintext
 * `solar-decoded.jsonl` the capture already holds, so this script opens no key file, no
 * `victron-adv.jsonl`, and never imports the advertisement decoder.
 *
 *   node --import ./scripts/support/typescriptResolve.mjs scripts/distill-fake-fixture.mjs
 *   node --import ./scripts/support/typescriptResolve.mjs scripts/distill-fake-fixture.mjs --pack-hz 1
 *
 * The pack records at about 3.76 Hz and that is what is committed, because at one frame a second
 * the fixture emits on the app's own sampling interval and hides exactly the jitter the dashboard
 * has to absorb. `--pack-hz` thins the pack stream for a smaller file when that trade is wanted.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeCellInfo, decodeDeviceInfo, decodeSettings } from '../src/domain/bms/decode.ts'
import { decodeLogbook } from '../src/domain/bms/logbook.ts'
import {
  detailLogOutcome,
  readDetailLogHeader,
  readDetailLogRecordBytes,
} from '../src/domain/bms/detailLog.ts'
import { hexToBytes } from '../src/domain/bytes.ts'
import { decodeSolarHistoryDay, decodeSolarHistoryTotals } from '../src/domain/solar/history.ts'
import {
  HISTORY_DAY_REGISTERS,
  HISTORY_TOTALS_REGISTER,
} from '../src/domain/solar/SolarHistoryRegister.ts'
import { BUNDLE_MARKER } from './support/fakeMarker.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CAPTURES = join(ROOT, 'captures')
const FIXTURES = join(ROOT, 'src', 'infrastructure', 'ble', 'fake', 'fixture')

/**
 * Stands in for the pack's real serial. It must be non-empty and it must be stable: it is what
 * `packDeviceKeyFor` turns into the archive's join key, and a pack with no serial and no advertised
 * name has no key at all, which makes every stored-log read unfileable.
 *
 * The key is spelled out rather than built by calling `packDeviceKeyFor`, because reaching that
 * function would pull the advertisement decoder in behind it and this script is meant to be unable
 * to touch anything that reads a key. `tests/fakeFixture.spec.ts` holds the two to each other.
 */
const DEMO_SERIAL = 'DEMO00000000001'
const PACK_DEVICE_KEY = `jk:${DEMO_SERIAL}`

/**
 * Minutes east of UTC the pack's own clock is set to. Its stored records carry a counter on that
 * clock and no zone, so this is the number that turns one into a date; it is the zone's standard
 * offset, in force all year, not the summer offset in force at the record.
 */
const PACK_UTC_OFFSET_MINUTES = 60

const PACK_FRAME_BYTES = 300
const CELL_INFO_FRAME = 2
const DEVICE_INFO_FRAME = 3
const SETTINGS_FRAME = 1
const STORED_LOG_FRAME = 0x06

const VOLTS_PLACES = 3
const AMPS_PLACES = 3
const AMP_HOURS_PLACES = 3
const OHMS_PLACES = 3
const WATTS_PLACES = 2
const CELSIUS_PLACES = 1

/** A serial is the only thing in these payloads that would read as text, so any text at all is one. */
const READABLE_TEXT = /[\x20-\x7e]{6,}/

/** Whole bytes, nothing else: a capture that lost half of one must not read as one byte shorter. */
const WHOLE_HEX_BYTES = /^(?:[0-9a-f]{2})+$/i

const MILLISECONDS_PER_MINUTE = 60_000

function packHzFromArgv() {
  const flag = process.argv.indexOf('--pack-hz')
  if (flag === -1) return null
  const hz = Number(process.argv[flag + 1])
  if (!Number.isFinite(hz) || hz <= 0) throw new Error('--pack-hz wants a positive number of frames a second')
  return hz
}

function round(value, places) {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}

/**
 * Capture hex to the bytes it names, through the parser the app's own fixtures go through.
 *
 * A capture gets one chance, and `hexToBytes` rejects nothing: a stray character reads as zero, a
 * dropped one re-pairs every byte behind it, and either would be committed as though the device had
 * sent it. So the text is settled here and the parse is still the shared one.
 */
function bytesOf(hex) {
  const packed = hex.replace(/\s+/g, '')
  if (!WHOLE_HEX_BYTES.test(packed)) {
    throw new Error(`expected whole hex bytes, got ${packed.length} characters: ${packed.slice(0, 24)}…`)
  }
  return hexToBytes(packed)
}

function hexOf(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function jsonLines(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function packFrames(directory) {
  return jsonLines(join(CAPTURES, directory, 'bms-frames.jsonl')).map((row) => {
    const frame = bytesOf(row.hex)
    if (frame.length !== PACK_FRAME_BYTES) {
      throw new Error(`${directory} carries a ${frame.length}-byte frame; the protocol frame is ${PACK_FRAME_BYTES}`)
    }
    return { at: row.t, type: row.type, frame }
  })
}

/** Every field rounded to what the wire actually carries, so no decimal noise reaches the file. */
function snapshotOf(frame) {
  const battery = decodeCellInfo(frame)
  return {
    cellVoltages: battery.cellVoltages.map((volts) => round(volts, VOLTS_PLACES)),
    cellResistances: battery.cellResistances.map((ohms) => round(ohms, OHMS_PLACES)),
    averageCellVoltage: round(battery.averageCellVoltage, VOLTS_PLACES),
    cellDelta: round(battery.cellDelta, VOLTS_PLACES),
    highestCell: battery.highestCell,
    lowestCell: battery.lowestCell,
    packVoltage: round(battery.packVoltage, VOLTS_PLACES),
    current: round(battery.current, AMPS_PLACES),
    power: round(battery.power, WATTS_PLACES),
    stateOfCharge: battery.stateOfCharge,
    remainingCapacity: round(battery.remainingCapacity, AMP_HOURS_PLACES),
    nominalCapacity: round(battery.nominalCapacity, AMP_HOURS_PLACES),
    cycleCount: battery.cycleCount,
    cycledCapacity: round(battery.cycledCapacity, AMP_HOURS_PLACES),
    mosfetTemperature: round(battery.mosfetTemperature, CELSIUS_PLACES),
    temperatureSensor1: round(battery.temperatureSensor1, CELSIUS_PLACES),
    temperatureSensor2: round(battery.temperatureSensor2, CELSIUS_PLACES),
    uptimeSeconds: battery.uptimeSeconds,
    chargingEnabled: battery.chargingEnabled,
    dischargingEnabled: battery.dischargingEnabled,
  }
}

/** The four keys the bridge's decoder spells differently from `SolarReading`; the rest already match. */
function readingOf(row) {
  return {
    chargeState: row.chargeState,
    chargerError: row.chargerError,
    batteryVoltage: row.batteryVoltageV,
    batteryCurrent: row.batteryCurrentA,
    yieldTodayKwh: row.yieldTodayKwh,
    pvPower: row.pvPowerW,
    loadCurrent: row.loadCurrentA,
  }
}

/**
 * One captured condition, both radios on the one time base the capture recorded them against.
 *
 * The base is whichever radio spoke first, so the offset between them survives — the pack answering
 * two and a half seconds after the controller is what the boat did, and starting both at zero would
 * be inventing a handshake the fake then plays back as though it were measured.
 */
function scenarioOf({ name, title, note, directory, packHz }) {
  const frames = packFrames(directory)
  const cellFrames = frames.filter((row) => row.type === CELL_INFO_FRAME)
  const solarRows = jsonLines(join(CAPTURES, directory, 'solar-decoded.jsonl')).map((row) => ({
    at: row.t,
    rssi: row.rssi,
    reading: readingOf(row),
  }))
  if (cellFrames.length === 0) throw new Error(`${directory} holds no cell-info frames`)
  if (solarRows.length === 0) throw new Error(`${directory} holds no decoded solar rows`)

  const origin = Math.min(cellFrames[0].at, solarRows[0].at)
  const atMsOf = (at) => Math.round((at - origin) * 1000)

  const minimumPackGap = packHz === null ? 0 : 1 / packHz
  const pack = []
  let lastKeptAt = Number.NEGATIVE_INFINITY
  for (const row of cellFrames) {
    if (row.at - lastKeptAt < minimumPackGap) continue
    lastKeptAt = row.at
    pack.push({ atMs: atMsOf(row.at), battery: snapshotOf(row.frame) })
  }

  // Two adapters logged the same broadcast a millisecond apart all through these captures. Replaying
  // both would have the fake emit a reading the controller only sent once.
  const solar = []
  let repeatedInstants = 0
  for (const row of solarRows) {
    const atMs = atMsOf(row.at)
    if (solar.length > 0 && atMs <= solar[solar.length - 1].atMs) {
      repeatedInstants += 1
      continue
    }
    solar.push({ atMs, rssi: row.rssi, reading: row.reading })
  }

  const spanMs = Math.max(pack[pack.length - 1].atMs, solar[solar.length - 1].atMs)
  return { scenario: { name, title, note, spanMs, pack, solar }, repeatedInstants }
}

/**
 * One stored-log read: the burst's frames up to the first that does not continue it.
 *
 * A burst starts at record 0 and each frame picks up exactly where the last left off, so a frame
 * whose first index is not the running total is where the pack stopped answering the ring in front
 * of it — everything after is left over from a read that is no longer the one being taken. Cutting
 * there is what makes a read contiguous by construction rather than by inspection, and it is the
 * difference between the later read reporting the 809 records it actually holds and reporting 836
 * whose newest forty came out of a burst three hours older.
 */
function storedLogRead(directory) {
  const path = join(CAPTURES, directory)
  const names = readdirSync(path)
    .filter((name) => /^detail-log-\d+\.hex$/.test(name))
    .sort()

  const frames = []
  let expectedIndex = 0
  let lastFile = null
  for (const name of names) {
    const frame = bytesOf(readFileSync(join(path, name), 'utf8'))
    if (frame.length !== PACK_FRAME_BYTES || frame[4] !== STORED_LOG_FRAME) continue
    const header = readDetailLogHeader(frame)
    if (header.firstRecordIndex !== expectedIndex) break
    frames.push(frame)
    expectedIndex = header.firstRecordIndex + header.recordCount
    lastFile = join(path, name)
  }
  if (frames.length === 0) throw new Error(`${directory} holds no stored-log frames`)

  // The frames carry the pack's RTC counter and no wall clock, so when the burst was taken is only
  // recorded by the capture file itself. Truncated to the minute: the second is false precision.
  const wroteAt = statSync(lastFile).mtimeMs
  const observedAt = Math.floor(wroteAt / MILLISECONDS_PER_MINUTE) * MILLISECONDS_PER_MINUTE

  return { read: { observedAt, frames: frames.map(hexOf) }, recordCount: expectedIndex }
}

/** The register values the controller answered, as the probe wrote them down. */
function answeredRegisters() {
  const lines = readFileSync(join(CAPTURES, 'victron-tunnel-registers-2026-08-02.txt'), 'utf8').split('\n')
  const answered = new Map()
  let inside = false
  for (const line of lines) {
    if (line.startsWith('===')) {
      inside = line.includes('ANSWERED')
      continue
    }
    if (!inside) continue
    const answer = /^\s*0x([0-9a-f]{4})\s+x\d+\s+lengths=\[[^\]]*\]\s+first=([0-9a-f]*)\s*$/.exec(line)
    if (answer) answered.set(Number.parseInt(answer[1], 16), answer[2])
  }
  return answered
}

function solarHistoryWire() {
  const answered = answeredRegisters()
  const totals = answered.get(HISTORY_TOTALS_REGISTER)
  if (!totals) throw new Error('the capture holds no answer for the solar history totals register')

  const days = HISTORY_DAY_REGISTERS.map((register) => {
    const bytes = answered.get(register)
    if (!bytes) throw new Error(`the capture holds no answer for solar history register 0x${register.toString(16)}`)
    return { register, bytes }
  })
  return { totals, days }
}

function deviceAndSettings(directory) {
  const frames = packFrames(directory)
  const deviceFrame = frames.find((row) => row.type === DEVICE_INFO_FRAME)
  const settingsFrame = frames.find((row) => row.type === SETTINGS_FRAME)
  if (!deviceFrame) throw new Error(`${directory} holds no device-info frame`)
  if (!settingsFrame) throw new Error(`${directory} holds no settings frame`)

  const captured = decodeDeviceInfo(deviceFrame.frame)
  return {
    device: { ...captured, serialNumber: DEMO_SERIAL },
    settings: decodeSettings(settingsFrame.frame),
    capturedSerial: captured.serialNumber,
  }
}

function logbook() {
  const frame = bytesOf(readFileSync(join(CAPTURES, 'frames', 'logbook-0x05.hex'), 'utf8'))
  if (frame.length !== PACK_FRAME_BYTES) {
    throw new Error(`the logbook capture is a ${frame.length}-byte frame; the protocol frame is ${PACK_FRAME_BYTES}`)
  }
  return decodeLogbook(frame)
}

/**
 * Refuses to write rather than warning.
 *
 * Everything below is either an identity that must not leave this machine or a shape the fake will
 * read back without checking. A fixture that fails one of these is worse than no fixture: it is
 * committed, so it would be wrong for as long as nobody looked.
 */
function validate({ playback, packRing, solarHistory, capturedSerial }) {
  const failures = []
  const texts = [JSON.stringify(playback), JSON.stringify(packRing), JSON.stringify(solarHistory)]

  if (playback.device.serialNumber !== DEMO_SERIAL) failures.push('the pack device info kept a serial that is not the demo one')
  // An empty captured serial is a refusal of its own. It is the string every fixture is searched
  // for, so a decode that handed back nothing would search for nothing and pass whatever it was
  // given — including the serial it was supposed to have found.
  if (!capturedSerial) failures.push('the capture decoded no pack serial, so nothing here is proof one was replaced')
  else if (texts.some((text) => text.includes(capturedSerial))) {
    failures.push('the pack serial the capture carries reached a fixture')
  }

  const payloads = [
    ...packRing.earlier.frames,
    ...packRing.later.frames,
    solarHistory.totals,
    ...solarHistory.days.map((day) => day.bytes),
  ]
  for (const payload of payloads) {
    const text = String.fromCharCode(...bytesOf(payload))
    if (READABLE_TEXT.test(text)) failures.push(`a wire payload reads as text, which is what a serial looks like: ${payload.slice(0, 24)}…`)
  }

  for (const scenario of playback.scenarios) {
    const streams = [['pack', scenario.pack], ['solar', scenario.solar]]
    for (const [stream, rows] of streams) {
      if (rows.length === 0) {
        failures.push(`${scenario.name} has no ${stream} rows`)
        continue
      }
      if (rows[0].atMs < 0) failures.push(`${scenario.name}'s ${stream} stream starts before the scenario does`)
      for (let index = 1; index < rows.length; index += 1) {
        if (rows[index].atMs <= rows[index - 1].atMs) {
          failures.push(`${scenario.name}'s ${stream} stream stalls or goes backwards at row ${index}`)
          break
        }
      }
    }
    // Both checks below read a stream's first and last row, which an empty stream has neither of.
    // It has already been refused, and reading it here would throw over reporting it.
    if (streams.some(([, rows]) => rows.length === 0)) continue
    const last = Math.max(scenario.pack[scenario.pack.length - 1].atMs, scenario.solar[scenario.solar.length - 1].atMs)
    if (scenario.spanMs !== last) failures.push(`${scenario.name}'s span does not reach its last row`)
    if (Math.min(scenario.pack[0].atMs, scenario.solar[0].atMs) !== 0) {
      failures.push(`${scenario.name} does not start at zero on either radio`)
    }
  }

  for (const half of ['earlier', 'later']) {
    const frames = packRing[half].frames.map(bytesOf)
    const indexes = frames.flatMap((frame) => readDetailLogRecordBytes(frame).map((record) => record.index))
    const firstBreak = indexes.findIndex((index, position) => index !== position)
    if (firstBreak !== -1) failures.push(`the ${half} stored-log read jumps to record ${indexes[firstBreak]} at position ${firstBreak}`)
    const outcome = detailLogOutcome({
      notificationBytes: frames.reduce((total, frame) => total + frame.length, 0),
      assembledFrameCount: frames.length,
      storedLogFrameCount: frames.length,
    })
    if (outcome !== 'records-read') failures.push(`the ${half} stored-log read reads as ${outcome}`)
  }

  const totals = decodeSolarHistoryTotals(bytesOf(solarHistory.totals))
  if (totals.daysAvailable === 0) failures.push('the totals record reports no days, so a sweep would ask for nothing')

  let previousSequence = null
  solarHistory.days.forEach((day, daysAgo) => {
    if (day.register !== HISTORY_DAY_REGISTERS[daysAgo]) failures.push(`solar history day ${daysAgo} names the wrong register`)
    const record = decodeSolarHistoryDay(bytesOf(day.bytes))
    if (!record.recorded) return
    if (previousSequence !== null && record.daySequenceNumber !== previousSequence - 1) {
      failures.push(`solar history day ${daysAgo} is out of sequence`)
    }
    previousSequence = record.daySequenceNumber
  })

  if (failures.length > 0) {
    console.error('Refusing to write the fixtures:')
    for (const failure of failures) console.error(`  ${failure}`)
    process.exit(1)
  }
}

const packHz = packHzFromArgv()
const { device, settings, capturedSerial } = deviceAndSettings('float-paired')

const float = scenarioOf({
  name: 'float',
  title: 'Float — three minutes at anchor',
  note:
    'The pack sitting at float on a sunny afternoon: 98% charge, a few amps in and out, and a cell ' +
    'spread that stays just under the threshold the dashboard calls serious. The controller holds ' +
    'float throughout at around seventy watts.',
  directory: 'float-paired',
  packHz,
})

const discharge = scenarioOf({
  name: 'discharge',
  title: 'Discharge — a heavy load',
  note:
    'Close to ninety amps out of a four-cell pack whose cells have drifted apart: the spread is a ' +
    'third of a volt, which is the serious cell-imbalance fault on real data rather than an ' +
    'authored one, and the first temperature sensor climbs four degrees while it runs. The ' +
    'controller crosses from float into bulk part way through. Fifty real seconds, so the panel ' +
    'loops it.',
  directory: 'discharge-paired',
  packHz,
})

const playback = {
  note:
    'Distilled from two paired boat captures of a JK_B2A8S20P and a SmartSolar MPPT 100/50. The ' +
    'pack streams are decoded frames, which is what leaves the identity in the frame behind — the ' +
    'serial is replaced with a demo value here. The solar streams come from the plaintext the captures ' +
    'already held, so no advertisement key was read and nothing was decrypted to produce this ' +
    'file. Discharge is fifty real seconds and the panel loops it; float runs three minutes. A ' +
    'third capture, first-pass, is left out: its solar is still ciphertext and its pack stream ' +
    'shows nothing float does not. Every fault state the dashboard can paint is applied over ' +
    'playback as a mutation rather than found here — across every decoded solar row the charger ' +
    'error is zero, there is no load output, and both pack switches are on in every frame.',
  marker: BUNDLE_MARKER,
  device,
  settings,
  logbook: logbook(),
  scenarios: [float.scenario, discharge.scenario],
}

const earlierRead = storedLogRead(join('detail-log', 'frames'))
const laterRead = storedLogRead('frames')

const packRing = {
  note:
    'Two whole stored-log bursts off the same pack, three and a half hours apart on 2026-08-01. The ' +
    'earlier read holds the ring full at 836 records; by the later one the ring has dropped 42 from ' +
    'its tail and added 15 at its head, so the two overlap by 794 and the fold has a real shift to ' +
    'survive rather than an arithmetic one. The frames carry no serial and no text of any kind, so ' +
    'they are committed as the pack sent them.',
  deviceKey: PACK_DEVICE_KEY,
  packUtcOffsetMinutes: PACK_UTC_OFFSET_MINUTES,
  earlier: earlierRead.read,
  later: laterRead.read,
}

const solarHistory = {
  note:
    'One sweep of a SmartSolar MPPT 100/50 over the 306b tunnel on 2026-08-02: the totals record ' +
    'and all thirty-one daily registers, newest first, as the controller answered them. Only the ' +
    'history registers are taken from the probe — the controller answered its serial in the same ' +
    'session and that register is not read here.',
  ...solarHistoryWire(),
}

validate({ playback, packRing, solarHistory, capturedSerial })

/**
 * The playback stream goes out compact and the two wire fixtures indented.
 *
 * A thousand frames laid out one field a line is twice the bytes for a diff nobody reads: every
 * timestamp rebases when the fixture is regenerated, so the whole file changes whatever the
 * formatting. The wire fixtures are a few dozen rows and stay legible.
 */
const written = [
  ['playbackFixture.json', JSON.stringify(playback)],
  ['packRingWire.json', JSON.stringify(packRing, null, 2)],
  ['solarHistoryWire.json', JSON.stringify(solarHistory, null, 2)],
]
for (const [name, text] of written) writeFileSync(join(FIXTURES, name), `${text}\n`)

function range(rows, pick) {
  const values = rows.map(pick)
  return `${Math.min(...values)} … ${Math.max(...values)}`
}

const cadence = packHz === null ? 'native' : `${packHz} Hz`
console.log(`wrote ${written.length} fixtures to src/infrastructure/ble/fake/fixture/ (pack cadence: ${cadence})`)
for (const [name] of written) {
  console.log(`  ${name}  ${(statSync(join(FIXTURES, name)).size / 1024).toFixed(0)} KB`)
}
for (const { scenario, repeatedInstants } of [float, discharge]) {
  console.log(
    `  ${scenario.name}: ${scenario.pack.length} pack frames and ${scenario.solar.length} solar readings ` +
      `over ${(scenario.spanMs / 1000).toFixed(1)} s (${repeatedInstants} repeated solar instants dropped)`,
  )
  console.log(
    `    packVoltage ${range(scenario.pack, (row) => row.battery.packVoltage)} V | ` +
      `current ${range(scenario.pack, (row) => row.battery.current)} A | ` +
      `power ${range(scenario.pack, (row) => row.battery.power)} W`,
  )
  console.log(
    `    cellDelta ${range(scenario.pack, (row) => row.battery.cellDelta)} V | ` +
      `soc ${range(scenario.pack, (row) => row.battery.stateOfCharge)} % | ` +
      `t1 ${range(scenario.pack, (row) => row.battery.temperatureSensor1)} °C`,
  )
  console.log(
    `    pvPower ${range(scenario.solar, (row) => row.reading.pvPower)} W | ` +
      `rssi ${range(scenario.solar, (row) => row.rssi)} dBm | ` +
      `states ${[...new Set(scenario.solar.map((row) => row.reading.chargeState))].join(', ')}`,
  )
}
console.log(
  `  stored log: ${packRing.earlier.frames.length} frames and ${earlierRead.recordCount} records earlier, ` +
    `${packRing.later.frames.length} and ${laterRead.recordCount} later`,
)
console.log(`  solar history: totals plus ${solarHistory.days.length} daily registers`)
console.log(`  logbook: ${playback.logbook.length} events`)
