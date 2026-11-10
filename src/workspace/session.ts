import { isValidToken, type Credential } from './api'

/**
 * The job token is a bearer secret: it lives in sessionStorage only (tab
 * scoped), never in the URL, never logged, and is cleared when invalid.
 */
const KEY = 'graveyard.workspace.job'

export function loadCredential(): Credential | null {
  try {
    const raw = window.sessionStorage.getItem(KEY)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object') {
      const { jobId, token } = value as { jobId?: unknown; token?: unknown }
      if (typeof jobId === 'string' && jobId.length > 0 && jobId.length <= 64 && isValidToken(token)) return { jobId, token }
    }
  } catch {
    // Unreadable or unavailable storage: treat as no saved job.
  }
  clearCredential()
  return null
}

export function saveCredential(cred: Credential): boolean {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(cred))
    return true
  } catch {
    return false
  }
}

export function clearCredential() {
  try {
    window.sessionStorage.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}
