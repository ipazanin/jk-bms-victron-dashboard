import { isReadableLayout, readPackSample, readSolarSample } from '../../domain/history/columns'
import type { SessionHour } from '../../domain/history/SessionHour'
import { summarizeSessionHours } from '../../domain/history/summarizeSessionHours'
import { PACK_STREAM } from '../../domain/history/types'
import type { HistoryChunk, PackSample, SolarSample, SessionId, SessionRecord } from '../../domain/history/types'
import { requestAsPromise } from './idb'

export async function compactSessionInTransaction(transaction: IDBTransaction, id: SessionId): Promise<void> {
  const sessions = transaction.objectStore('sessions')
  const record = await requestAsPromise<SessionRecord | undefined>(sessions.get(id))
  if (record === undefined || record.hourlyBasis === 'recorded' || (record.state === 'closed' && record.hourlyBasis === 'reconstructed')) return
  const chunks = await requestAsPromise<HistoryChunk[]>(transaction.objectStore('chunks').index('bySession').getAll(id))
  const readable = chunks.filter((chunk) => isReadableLayout(chunk.layout) && chunk.length > 0)
  if (readable.length === 0) return
  const hours = transaction.objectStore('sessionHours')
  const existing = await requestAsPromise<SessionHour[]>(hours.index('bySession').getAll(id))
  const present = new Map(existing.map((hour) => [hour.hourStart, hour]))
  const hourStarts = new Set<number>()
  const hourMs = 3_600_000
  for (const chunk of readable) {
    for (let index = 0; index < chunk.length; index += 1) {
      hourStarts.add(Math.floor((chunk.baseAt + chunk.offsetMs[index]!) / hourMs) * hourMs)
    }
  }
  for (const hourStart of hourStarts) {
    const previous = present.get(hourStart)
    if (previous?.basis === 'recorded') continue
    if (previous !== undefined && record?.retainedFrom !== null && record?.retainedFrom !== undefined && hourStart < record.retainedFrom) continue
    const pack: PackSample[] = []
    const solar: SolarSample[] = []
    for (const chunk of readable) {
      if (chunk.baseAt > hourStart + hourMs + 8_000 || (chunk.baseAt + chunk.offsetMs[chunk.length - 1]!) < hourStart - 11_000) continue
      for (let index = 0; index < chunk.length; index += 1) {
        const at = chunk.baseAt + chunk.offsetMs[index]!
        if (at < hourStart - 11_000 || at > hourStart + hourMs + 8_000) continue
        if (chunk.stream === PACK_STREAM) pack.push(readPackSample(chunk, index))
        else solar.push(readSolarSample(chunk, index))
      }
    }
    for (const hour of summarizeSessionHours(id, pack, solar)) {
      if (hour.hourStart === hourStart) await requestAsPromise(hours.put(hour))
    }
  }
  await requestAsPromise(sessions.put({ ...record, hourlyBasis: 'reconstructed' }))
}
