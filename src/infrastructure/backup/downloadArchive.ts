export function downloadArchive(fileName: string, archive: Blob): void {
  if (typeof URL.createObjectURL !== 'function') {
    throw new Error('This browser cannot download files. Open Shunt in a browser with download support.')
  }
  const url = URL.createObjectURL(archive)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Firefox can start the download after the click handler has returned.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
