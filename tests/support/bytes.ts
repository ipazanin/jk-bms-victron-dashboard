/**
 * Fixture hex to the bytes it names.
 *
 * The captured frames in `tests/fixtures.json` are stored as hex; this turns one back into the
 * bytes a decoder sees. It validates nothing, deliberately — the fixtures are checked in, so a spec
 * that mistypes one should fail on the decode it is asserting rather than on a guard in its own
 * scaffolding. Hex that arrives at runtime is the opposite problem and wants a parser that rejects
 * rubbish, which is why `BridgeSolarScan` has its own.
 */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}
