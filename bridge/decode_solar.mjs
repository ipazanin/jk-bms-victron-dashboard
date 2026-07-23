#!/usr/bin/env node
// Decode captured Victron Instant Readout advertisements with the owner's key — a line-for-line
// mirror of src/domain/solar/advertisement.ts, using Node's webcrypto. Development only; the key is
// read from a gitignored local file and never leaves this machine.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CAPTURES = join(ROOT, 'captures')

const RECORD_SOLAR_CHARGER = 0x01
const NOT_AVAILABLE_I16 = 0x7fff
const NOT_AVAILABLE_U16 = 0xffff
const NOT_AVAILABLE_U9 = 0x1ff
const CHARGE_STATES = { 0: 'off', 2: 'fault', 3: 'bulk', 4: 'absorption', 5: 'float', 7: 'equalize', 245: 'starting' }

const keyHex = (process.argv[3] ?? readFileSync(join(CAPTURES, 'victron-key.txt'), 'utf8')).trim().toLowerCase().replace(/\s+/g, '')
if (!/^[0-9a-f]{32}$/.test(keyHex)) throw new Error('key must be 32 hex chars')
const keyBytes = Uint8Array.from(keyHex.match(/../g).map((h) => parseInt(h, 16)))

const advPath = process.argv[2] ?? join(CAPTURES, 'victron-adv.jsonl')
const rows = readFileSync(advPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-CTR', false, ['decrypt'])

function counterBlock(nonce) {
  const c = new Uint8Array(16)
  c[0] = nonce & 0xff
  c[1] = (nonce >> 8) & 0xff
  return c
}

async function decode(payload) {
  if (payload.length < 8 || payload[0] !== 0x10) return null
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const recordType = payload[4]
  const nonce = dv.getUint16(5, true)
  const keyCheckByte = payload[7]
  if (recordType !== RECORD_SOLAR_CHARGER) return { skip: 'not-solar', modelId: dv.getUint16(2, true) }
  if (keyCheckByte !== keyBytes[0]) return { skip: 'key-mismatch' }
  const ciphertext = payload.slice(8)
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CTR', counter: counterBlock(nonce), length: 128 }, cryptoKey, ciphertext))
  const d = new DataView(pt.buffer, pt.byteOffset, pt.byteLength)
  const voltage = d.getInt16(2, true)
  const current = d.getInt16(4, true)
  const yieldToday = d.getUint16(6, true)
  const pvPower = d.getUint16(8, true)
  const loadCurrent = pt.length >= 12 ? pt[10] | ((pt[11] & 0x01) << 8) : NOT_AVAILABLE_U9
  return {
    chargeState: CHARGE_STATES[pt[0]] ?? 'unknown',
    chargerError: pt[1],
    batteryVoltageV: voltage === NOT_AVAILABLE_I16 ? null : voltage / 100,
    batteryCurrentA: current === NOT_AVAILABLE_I16 ? null : current / 10,
    yieldTodayKwh: yieldToday === NOT_AVAILABLE_U16 ? null : yieldToday / 100,
    pvPowerW: pvPower === NOT_AVAILABLE_U16 ? null : pvPower,
    loadCurrentA: loadCurrent === NOT_AVAILABLE_U9 ? null : loadCurrent / 10,
  }
}

const decoded = []
let matched = 0
let skipped = 0
for (const row of rows) {
  const payload = Uint8Array.from(row.mfg.match(/../g).map((h) => parseInt(h, 16)))
  const r = await decode(payload)
  if (r && r.skip) { skipped += 1; continue }
  if (!r) { skipped += 1; continue }
  matched += 1
  decoded.push({ t: row.t, rssi: row.rssi, ...r })
}

writeFileSync(join(CAPTURES, 'solar-decoded.jsonl'), decoded.map((d) => JSON.stringify(d)).join('\n') + '\n')

const nums = (k) => decoded.map((d) => d[k]).filter((v) => v !== null)
const range = (k) => { const a = nums(k); return a.length ? `${Math.min(...a)} … ${Math.max(...a)}` : 'n/a' }
const states = {}
for (const d of decoded) states[d.chargeState] = (states[d.chargeState] ?? 0) + 1

console.log(`decoded ${matched}/${rows.length} (skipped ${skipped}) -> captures/solar-decoded.jsonl`)
console.log('chargeState:', states)
console.log('pvPowerW:', range('pvPowerW'), '| last', decoded.at(-1)?.pvPowerW)
console.log('batteryVoltageV:', range('batteryVoltageV'))
console.log('batteryCurrentA:', range('batteryCurrentA'))
console.log('yieldTodayKwh:', range('yieldTodayKwh'))
console.log('loadCurrentA:', range('loadCurrentA'))
console.log('sample rows:')
for (const d of decoded.slice(0, 3)) console.log('  ', JSON.stringify(d))
