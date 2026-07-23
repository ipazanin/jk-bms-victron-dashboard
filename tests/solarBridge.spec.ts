import { describe, expect, it } from 'vitest'

import { resolveSolarBridgeUrl } from '../src/infrastructure/ble/solarBridge'

const DEFAULT = 'ws://localhost:8787'

describe('resolveSolarBridgeUrl', () => {
  it('returns null when no bridge parameter is present', () => {
    expect(resolveSolarBridgeUrl('')).toBeNull()
    expect(resolveSolarBridgeUrl('?foo=bar')).toBeNull()
  })

  it('uses the default localhost url for the on flags', () => {
    expect(resolveSolarBridgeUrl('?bridge')).toBe(DEFAULT)
    expect(resolveSolarBridgeUrl('?bridge=1')).toBe(DEFAULT)
    expect(resolveSolarBridgeUrl('?bridge=true')).toBe(DEFAULT)
  })

  it('honours an explicit ws or wss url', () => {
    expect(resolveSolarBridgeUrl('?bridge=ws://192.168.1.5:9000')).toBe('ws://192.168.1.5:9000')
    expect(resolveSolarBridgeUrl('?bridge=wss://host:8787')).toBe('wss://host:8787')
  })

  it('assumes ws:// for a bare host:port', () => {
    expect(resolveSolarBridgeUrl('?bridge=localhost:9999')).toBe('ws://localhost:9999')
  })

  it('treats explicit off values as no bridge', () => {
    expect(resolveSolarBridgeUrl('?bridge=0')).toBeNull()
    expect(resolveSolarBridgeUrl('?bridge=false')).toBeNull()
  })
})
