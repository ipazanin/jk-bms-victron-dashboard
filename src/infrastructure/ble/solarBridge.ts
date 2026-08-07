/**
 * Whether to read solar over the native bridge instead of the browser's own radio, and where.
 *
 * A runtime toggle, not a build flag: open the app with `?bridge=1` and it connects to the local
 * helper on ws://localhost:8787; `?bridge=ws://host:port` points it elsewhere; `?bridge=0` forces
 * it off. Absent the parameter, `SolarLiveScan` picks a browser radio and the deployed site behaves
 * exactly as before. This predates the watch route and remains the fallback for a browser that has
 * neither radio — see BridgeSolarScan.ts and the bridge/ directory.
 */

const DEFAULT_SOLAR_BRIDGE_URL = 'ws://localhost:8787'

export function resolveSolarBridgeUrl(search: string): string | null {
  const params = new URLSearchParams(search)
  if (!params.has('bridge')) return null

  const value = (params.get('bridge') ?? '').trim()
  if (value === '0' || value === 'false') return null
  if (value === '' || value === '1' || value === 'true') return DEFAULT_SOLAR_BRIDGE_URL
  if (/^wss?:\/\//i.test(value)) return value
  // A bare host:port is a convenience; the helper only ever speaks plain ws over loopback.
  return `ws://${value}`
}
