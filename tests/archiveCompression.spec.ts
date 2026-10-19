import { crc32, gzipSync, gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { compressArchiveBytes, decompressArchiveBytes } from '../src/application/backup/archiveCompression'

const source = new TextEncoder().encode('Archive 🌊 '.repeat(20_000))

describe('gzip archive transport', () => {
  it('writes deterministic gzip that an independent implementation can read', () => {
    const compressed = compressArchiveBytes(source)
    expect(compressArchiveBytes(source)).toEqual(compressed)
    expect(Array.from(compressed.subarray(4, 8))).toEqual([0, 0, 0, 0])
    expect(new Uint8Array(gunzipSync(compressed))).toEqual(source)
  })

  it('reads independently compressed bytes and an empty gzip member', () => {
    expect(decompressArchiveBytes(gzipSync(source), source.byteLength)).toEqual(source)
    expect(decompressArchiveBytes(gzipSync(new Uint8Array()), 0)).toEqual(new Uint8Array())
  })

  it('accepts optional gzip header fields and verifies their checksum', () => {
    const compressed = gzipSync(source)
    const filename = new TextEncoder().encode(`${'archive'.repeat(1000)}.json\0`)
    const extra = new Uint8Array([3, 0, 65, 66, 67])
    const comment = new TextEncoder().encode('Backup\0')
    const header = new Uint8Array(10 + extra.length + filename.length + comment.length + 2)
    header.set(compressed.subarray(0, 10))
    header[3] = 2 | 4 | 8 | 16
    header.set(extra, 10)
    header.set(filename, 10 + extra.length)
    header.set(comment, 10 + extra.length + filename.length)
    new DataView(header.buffer).setUint16(header.length - 2, crc32(header.subarray(0, -2)) & 0xffff, true)
    const withHeader = new Uint8Array(header.length + compressed.length - 10)
    withHeader.set(header)
    withHeader.set(compressed.subarray(10), header.length)
    expect(new Uint8Array(gunzipSync(withHeader))).toEqual(source)
    expect(decompressArchiveBytes(withHeader, source.byteLength)).toEqual(source)
    withHeader[header.length - 2]! ^= 1
    expect(() => decompressArchiveBytes(withHeader, source.byteLength)).toThrow('header checksum')
  })

  it.each([1, 4, 8, 10])('rejects gzip truncated by %i bytes', (missingBytes) => {
    const compressed = gzipSync(source)
    expect(() => decompressArchiveBytes(compressed.subarray(0, -missingBytes), source.byteLength)).toThrow()
  })

  it('rejects a corrupt checksum even when the decoded bytes are valid', () => {
    const compressed = new Uint8Array(gzipSync(source))
    compressed[compressed.length - 8]! ^= 1
    expect(() => decompressArchiveBytes(compressed, source.byteLength)).toThrow('checksum')
  })

  it('rejects incorrect decoded lengths in either direction', () => {
    for (const length of [source.byteLength - 1, source.byteLength + 1]) {
      const compressed = new Uint8Array(gzipSync(source))
      new DataView(compressed.buffer).setUint32(compressed.length - 4, length, true)
      expect(() => decompressArchiveBytes(compressed, source.byteLength + 1)).toThrow()
    }
  })

  it('rejects an oversized footer before allocating output and checks actual expansion', () => {
    const compressed = new Uint8Array(gzipSync(new Uint8Array(8 * 1024 * 1024)))
    expect(() => decompressArchiveBytes(compressed, 1024)).toThrow('size limit')
    new DataView(compressed.buffer).setUint32(compressed.length - 4, 1024, true)
    expect(() => decompressArchiveBytes(compressed, 1024)).toThrow('declared size')
  })

  it.each([1, 3, 8, 12])('rejects %i trailing bytes, including a copied valid footer', (length) => {
    const compressed = gzipSync(source)
    const trailing = new Uint8Array(compressed.length + length + 8)
    trailing.set(compressed)
    trailing.set(compressed.subarray(-8), trailing.length - 8)
    expect(() => decompressArchiveBytes(trailing, source.byteLength)).toThrow()
  })

  it('rejects concatenated gzip members even when the second member is empty', () => {
    const compressed = gzipSync(source)
    for (const second of [gzipSync(source), gzipSync(new Uint8Array())]) {
      const joined = new Uint8Array(compressed.length + second.length)
      joined.set(compressed)
      joined.set(second, compressed.length)
      expect(() => decompressArchiveBytes(joined, source.byteLength * 2)).toThrow()
    }
  })

  it('rejects reserved header flags and unterminated filenames', () => {
    const compressed = new Uint8Array(gzipSync(source))
    compressed[3] = 0x80
    expect(() => decompressArchiveBytes(compressed, source.byteLength)).toThrow('header')
    const invalid = new Uint8Array(30).fill(65)
    invalid.set([31, 139, 8, 8, 0, 0, 0, 0, 0, 3])
    expect(() => decompressArchiveBytes(invalid, source.byteLength)).toThrow('header')
  })
})
