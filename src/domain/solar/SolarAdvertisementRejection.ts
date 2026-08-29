/**
 * Why a Victron advertisement did not become a reading.
 *
 * Three unrelated checks end the decode early and each points at a different control in
 * VictronConnect, so they are named apart rather than collapsed into one null. Collapsing them is
 * what had the page blaming the marina for a key the controller had quietly reissued.
 *
 * On the watch route the page follows one device handle, so every advertisement it sees comes from
 * the owner's own controller. That makes each of these a statement about that unit rather than a
 * guess about the neighbours, and the scan route — the only one that hears the whole marina — is
 * the only place a key mismatch can mean anyone else at all. Which of the two heard it travels
 * beside the reason as a `SolarAdvertisementSource`: a sentence about one of these is wrong on one
 * route or the other unless it is told which.
 *
 * - `not-instant-readout` the manufacturer payload does not open with 0x10, or is too short to hold
 *                         a header. Victron hardware broadcasts other manufacturer records, and a
 *                         unit with Instant Readout switched off broadcasts nothing but those — so
 *                         this is the toggle, never the key.
 * - `other-record`        an Instant Readout record of some other kind. Battery monitors, inverters
 *                         and DC-DC chargers all broadcast under the same company id, and only the
 *                         solar-charger record decodes into a reading here.
 * - `key-mismatch`        the record's check byte is not the first byte of the stored key. Victron
 *                         reissues the encryption key every time Instant Readout is switched off
 *                         and on, so a stored key is stale far more often than it is wrong.
 */
export type SolarAdvertisementRejection = 'not-instant-readout' | 'other-record' | 'key-mismatch'
