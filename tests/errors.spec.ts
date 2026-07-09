import { describe, expect, it } from 'vitest'

import { describeConnectError, describeScanError } from '../src/application/errors'

function domException(name: string, message = 'raw browser text'): Error {
  const error = new Error(message)
  error.name = name
  return error
}

describe('describeConnectError', () => {
  it('says nothing when the user simply closed the chooser', () => {
    expect(describeConnectError(new Error('User cancelled the requestDevice() chooser.'))).toBeNull()
    expect(describeConnectError(new Error('User canceled the requestDevice() chooser.'))).toBeNull()
  })

  it('names the single-connection trap when no device is offered', () => {
    const message = describeConnectError(domException('NotFoundError'))!
    expect(message).toMatch(/JK app/)
    expect(message).toMatch(/one Bluetooth connection|only Bluetooth connection/)
    expect(message).toMatch(/Show every nearby device/)
  })

  it('names it again when the link is refused mid-handshake', () => {
    const message = describeConnectError(domException('NetworkError'))!
    expect(message).toMatch(/one Bluetooth connection at a time/)
  })

  it('explains a blocked request rather than echoing SecurityError', () => {
    const message = describeConnectError(domException('SecurityError'))!
    expect(message).not.toMatch(/SecurityError/)
    expect(message).toMatch(/HTTPS/)
  })

  it('points unsupported browsers at one that works', () => {
    expect(describeConnectError(domException('NotSupportedError'))!).toMatch(/Chrome|Bluefy/)
  })

  it('falls back to the raw message for anything unrecognised', () => {
    expect(describeConnectError(domException('WeirdError', 'something odd'))).toBe('something odd')
  })
})

describe('describeScanError', () => {
  it('tells the user how to recover from a declined scan prompt', () => {
    expect(describeScanError(domException('NotAllowedError'))).toMatch(/Connect solar again/)
  })

  it('passes other messages through', () => {
    expect(describeScanError(domException('Whatever', 'plain text'))).toBe('plain text')
  })
})
