/**
 * Browsers surface these as bare DOMException names. Left raw they read as noise, and the
 * commonest cause by far — the JK phone app holding the BMS's only connection slot — is
 * invisible in every one of them.
 */

/** Returns null when the user simply closed the chooser: that is not an error. */
export function describeConnectError(error: Error): string | null {
  const name = (error as DOMException).name
  if (/cancell?ed/i.test(error.message)) return null

  switch (name) {
    case 'NotFoundError':
      return (
        'No BMS offered. It may be out of range, or the JK app on your phone is holding the ' +
        'BMS’s only Bluetooth connection — close the app, then try again. If it still does not ' +
        'appear, tick “Show every nearby device”.'
      )
    case 'NetworkError':
      return (
        'The BMS refused the connection or dropped it. It accepts one Bluetooth connection at a ' +
        'time — close the JK app on your phone, then retry.'
      )
    case 'SecurityError':
      return 'The browser blocked the request. Open this page over HTTPS and click Connect directly.'
    case 'NotSupportedError':
      return 'This browser cannot talk to the BMS. Use Chrome or Edge on desktop, Chrome on Android, or Bluefy on iOS.'
    default:
      return error.message
  }
}

export function describeScanError(error: Error): string {
  if ((error as DOMException).name === 'NotAllowedError') {
    return 'Bluetooth scanning was declined. Click Connect solar again and allow the prompt.'
  }
  return error.message
}
