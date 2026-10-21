import type { ArchivePreference } from '../../domain/backup/ArchivePreference'
import { SHARED_PREFERENCE_KEYS } from '../../domain/sync/sharedSettings'
import { applyArchivePreferences } from '../backup/preferences'
import { storageKey } from '../storageKey'
import type { GoogleSyncState } from './GoogleSyncState'

const DEFAULT_STATE: GoogleSyncState = {
  enabled: false, autoSync: true, includeSecret: false, sourceLabel: '', workspace: null,
  lastSyncAt: null, settingsBaseline: null, downloaded: {},
}

export function loadGoogleSyncState(): GoogleSyncState {
  try {
    const stored = localStorage.getItem(storageKey('shunt.googleSync'))
    if (!stored) return DEFAULT_STATE
    const saved: unknown = JSON.parse(stored)
    if (!saved || typeof saved !== 'object') return DEFAULT_STATE
    const candidate = saved as Record<string, unknown>
    const workspace = candidate.workspace as GoogleSyncState['workspace']
    const baseline = candidate.settingsBaseline as GoogleSyncState['settingsBaseline']
    const downloaded = candidate.downloaded
    return {
      enabled: candidate.enabled === true,
      autoSync: candidate.autoSync !== false,
      includeSecret: candidate.includeSecret === true,
      sourceLabel: typeof candidate.sourceLabel === 'string' ? candidate.sourceLabel.slice(0, 100) : '',
      workspace: workspace && typeof workspace.name === 'string' && workspace.name.length <= 200
        && validId(workspace.id) && validId(workspace.folderId)
        && (workspace.version === undefined || workspace.version === 1 || workspace.version === 2 || workspace.version === 3) ? workspace : null,
      lastSyncAt: typeof candidate.lastSyncAt === 'number' && Number.isFinite(candidate.lastSyncAt) && candidate.lastSyncAt >= 0 ? candidate.lastSyncAt : null,
      settingsBaseline: baseline && validId(baseline.workspaceId) && typeof baseline.localHash === 'string'
        && /^[a-f0-9]{64}$/.test(baseline.localHash) && typeof baseline.cloudHash === 'string' && /^[a-f0-9]{64}$/.test(baseline.cloudHash)
        ? { workspaceId: baseline.workspaceId, localHash: baseline.localHash, cloudHash: baseline.cloudHash } : null,
      downloaded: downloaded && typeof downloaded === 'object' && !Array.isArray(downloaded)
        ? Object.fromEntries(Object.entries(downloaded).filter(([source, revision]) => validId(source) && validId(revision))) as Record<string, string>
        : {},
    }
  } catch {
    return DEFAULT_STATE
  }
}

export function saveGoogleSyncState(state: GoogleSyncState): void {
  localStorage.setItem(storageKey('shunt.googleSync'), JSON.stringify(state))
}

export function applySharedPreferences(preferences: readonly ArchivePreference[], includeSecret: boolean): void {
  applyArchivePreferences(preferences, includeSecret, SHARED_PREFERENCE_KEYS)
}

function validId(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 1024
}
