/**
 * Hands a document to the browser's downloader.
 *
 * The parts are joined by the Blob rather than by a string concatenation: the export is emitted a
 * row at a time precisely so a session never exists as one multi-megabyte string, and joining it
 * here would put it back.
 *
 * The object URL is revoked a turn later, not immediately. Revoking in the same task as the click
 * races the download the click started, and the browser that loses the race saves nothing and says
 * nothing.
 */

const JSON_MEDIA_TYPE = 'application/json'

/** False when this browser has no object URLs to hand out — in-app browsers where downloads are
 *  disabled entirely — so the caller can say so instead of appearing to have saved the file. */
export function downloadJson(fileName: string, parts: Iterable<string>): boolean {
  if (typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') return false

  const url = URL.createObjectURL(new Blob([...parts], { type: JSON_MEDIA_TYPE }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  // Never attached to the document: a click on a detached anchor still downloads, and nothing has
  // to be cleaned up out of a layout the page did not ask for.
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return true
}
