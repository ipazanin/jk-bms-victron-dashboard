const loading = new Map<string, Promise<void>>()

export function loadGoogleScript(src: string): Promise<void> {
  const pending = loading.get(src)
  if (pending) return pending
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    const timeout = window.setTimeout(() => fail(), 20_000)
    function fail() {
      window.clearTimeout(timeout)
      script.remove()
      loading.delete(src)
      reject(new Error('Google could not load. Check your connection or content blocker, then try again.'))
    }
    script.src = src
    script.async = true
    script.addEventListener('load', () => {
      window.clearTimeout(timeout)
      resolve()
    }, { once: true })
    script.addEventListener('error', fail, { once: true })
    document.head.append(script)
  })
  loading.set(src, promise)
  return promise
}
