import { Gunzip, gzipSync } from 'fflate'

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let checksum = index
  for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0)
  return checksum >>> 0
})
const GZIP_HEADER = new Uint8Array([31, 139, 8, 0, 0, 0, 0, 0, 0, 3])

export function compressArchiveBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(gzipSync(bytes, { mtime: 0, level: 6 }))
}

export function decompressArchiveBytes(bytes: Uint8Array, maxDecodedBytes: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 0) throw new Error('The archive decompression limit is invalid.')
  const headerBytes = validateGzipHeader(bytes)
  const trailer = new DataView(bytes.buffer, bytes.byteOffset + bytes.byteLength - 8, 8)
  const expectedChecksum = trailer.getUint32(0, true)
  const expectedBytes = trailer.getUint32(4, true)
  if (expectedBytes > maxDecodedBytes) throw new Error('The decompressed archive exceeds its size limit.')
  const chunks: Uint8Array[] = []
  let decodedBytes = 0
  let checksum = 0xffffffff
  let complete = false
  const gunzip = new Gunzip((chunk) => {
    decodedBytes += chunk.byteLength
    if (decodedBytes > maxDecodedBytes || decodedBytes > expectedBytes) throw new Error('The decompressed archive exceeds its declared size.')
    checksum = crc32(chunk, checksum)
    if (chunk.byteLength > 0) chunks.push(chunk)
  })
  gunzip.onmember = (offset) => {
    if (offset !== bytes.byteLength) throw new Error('The gzip archive contains additional members or trailing bytes.')
    complete = true
  }
  try {
    gunzip.push(bytes.subarray(0, headerBytes))
    for (let offset = headerBytes; offset < bytes.byteLength; offset += 1024) gunzip.push(bytes.subarray(offset, offset + 1024))
    // fflate reports the previous member's exact end only when it sees another header.
    gunzip.push(GZIP_HEADER)
  } catch (error) {
    throw new Error(`The gzip archive could not be decompressed: ${error instanceof Error ? error.message : 'invalid compressed data'}`)
  }
  if (!complete || decodedBytes !== expectedBytes) throw new Error('The gzip archive is truncated or its decoded size does not match.')
  if (((checksum ^ 0xffffffff) >>> 0) !== expectedChecksum) throw new Error('The gzip archive checksum does not match.')
  const decoded = new Uint8Array(decodedBytes)
  let offset = 0
  for (const chunk of chunks) {
    decoded.set(chunk, offset)
    offset += chunk.byteLength
  }
  return decoded
}

function validateGzipHeader(bytes: Uint8Array): number {
  if (bytes.byteLength < 20 || bytes[0] !== 31 || bytes[1] !== 139 || bytes[2] !== 8 || (bytes[3]! & 0xe0) !== 0) {
    throw new Error('The gzip archive header is invalid or truncated.')
  }
  const flags = bytes[3]!
  const end = bytes.byteLength - 8
  let offset = 10
  if (flags & 4) {
    if (offset + 2 > end) throw new Error('The gzip archive header is truncated.')
    offset += 2 + bytes[offset]! + (bytes[offset + 1]! << 8)
  }
  for (const flag of [8, 16]) {
    if (flags & flag) {
      while (offset < end && bytes[offset] !== 0) offset += 1
      offset += 1
    }
  }
  if (flags & 2) {
    if (offset + 2 > end) throw new Error('The gzip archive header is truncated.')
    const expected = bytes[offset]! | (bytes[offset + 1]! << 8)
    if (((crc32(bytes.subarray(0, offset), 0xffffffff) ^ 0xffffffff) & 0xffff) !== expected) throw new Error('The gzip archive header checksum does not match.')
    offset += 2
  }
  if (offset >= end) throw new Error('The gzip archive header is truncated.')
  return offset
}

function crc32(bytes: Uint8Array, checksum: number): number {
  for (const byte of bytes) checksum = CRC_TABLE[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8)
  return checksum
}
