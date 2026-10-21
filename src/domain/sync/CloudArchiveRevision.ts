import type { CloudJsonRevision } from './CloudJsonRevision'
import type { CloudSnapshotRevision } from './CloudSnapshotRevision'
import type { LegacyCloudArchiveRevision } from './LegacyCloudArchiveRevision'

export type CloudArchiveRevision = LegacyCloudArchiveRevision | CloudSnapshotRevision | CloudJsonRevision
