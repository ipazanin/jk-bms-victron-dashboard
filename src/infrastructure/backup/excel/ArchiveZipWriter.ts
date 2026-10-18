import { Zip, ZipDeflate } from 'fflate'

export class ArchiveZipWriter {
  private readonly zip: Zip
  private readonly maxExpandedBytes: number
  private readonly chunks: Uint8Array[] = []
  private length = 0
  private expandedLength = 0

  constructor(maxBytes: number, maxExpandedBytes: number) {
    this.maxExpandedBytes = maxExpandedBytes
    this.zip = new Zip((error, bytes) => {
      if (error) throw error
      this.length += bytes.byteLength
      if (this.length > maxBytes) throw new Error('Archive exceeds the supported file size')
      this.chunks.push(bytes)
    })
  }

  add(name: string, bytes: Uint8Array): void {
    this.expandedLength += bytes.byteLength
    if (this.expandedLength > this.maxExpandedBytes) throw new Error('Expanded ZIP exceeds the supported limit')
    const entry = new ZipDeflate(name, { level: 6 })
    this.zip.add(entry)
    // Each entry retains its compressor buffer until the ZIP is finalized.
    const chunkSize = 64 * 1024
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, bytes.length)
      entry.push(bytes.subarray(offset, end), end === bytes.length)
    }
    if (bytes.length === 0) entry.push(bytes, true)
  }

  finish(): Uint8Array<ArrayBuffer> {
    this.zip.end()
    const bytes = new Uint8Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  }
}
