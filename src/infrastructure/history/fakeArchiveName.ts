/**
 * The archive a playback build records into.
 *
 * Both builds are served from one origin, so one name would be one database and a fabricated session
 * would land in the boat's log permanently. The name is derived from the shipping one rather than
 * written out, so a rename moves both together.
 *
 * It carries no flag of its own. Whoever opens the archive decides which of the two names to open,
 * and compares in place there rather than behind a shared constant, which no longer folds —
 * `scripts/assert-no-fake-bytes.mjs` has the measurement. A control that seeds or wipes the
 * playback archive can only ever mean this one, and pointing it at a name that could resolve to the
 * shipping archive is how a dev button deletes a season of recordings.
 */

import { DATABASE_NAME } from './IdbHistoryStore'

export const FAKE_ARCHIVE_NAME = `${DATABASE_NAME}.fake`
