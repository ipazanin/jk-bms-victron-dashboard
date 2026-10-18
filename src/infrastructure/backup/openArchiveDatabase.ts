export function openArchiveDatabase(
  name: string,
  version: number,
  upgrade: (database: IDBDatabase, oldVersion: number) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    let settled = false
    let blockedTimer: ReturnType<typeof setTimeout> | undefined
    request.onupgradeneeded = (event) => {
      upgrade(request.result, event.oldVersion)
    }
    request.onblocked = () => {
      blockedTimer ??= setTimeout(() => {
        settled = true
        reject(new Error('Another tab is blocking the archive database.'))
      }, 3_000)
    }
    request.onsuccess = () => {
      clearTimeout(blockedTimer)
      if (settled) {
        request.result.close()
        return
      }
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = (event) => {
      event.preventDefault()
      clearTimeout(blockedTimer)
      reject(request.error ?? new Error('The archive database could not be opened.'))
    }
  })
}
