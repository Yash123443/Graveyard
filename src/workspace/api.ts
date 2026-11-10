/** Typed client for the GRAVEYARD backend (same-origin `/api`, proxied by Vite). */

export const TERMINAL_STATUSES: readonly string[] = ['completed', 'failed', 'cancelled', 'timed-out']
export const TERMINAL_EVENTS: readonly string[] = ['completed', 'failed', 'cancelled', 'timed-out']

export interface JobMeta {
  jobId: string
  repoUrl: string
  stage: string
  status: string
  createdAt: string
  updatedAt: string
}

export interface Credential {
  jobId: string
  token: string
}

export class ApiError extends Error {
  readonly status: number
  /** True when no HTTP response was received at all. */
  readonly network: boolean
  readonly retryAfterSeconds: number | undefined
  constructor(status: number, message: string, network = false, retryAfterSeconds?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.network = network
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** Only network failures and 5xx are worth retrying automatically. */
export const isTransient = (error: unknown) => error instanceof ApiError && (error.network || error.status >= 500)

const TOKEN_RE = /^[0-9a-f]{64}$/
const REPO_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export const isValidToken = (value: unknown): value is string => typeof value === 'string' && TOKEN_RE.test(value)
export const looksLikeRepoUrl = (value: string) => REPO_RE.test(value)

export const authHeaders = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` })

export const eventsUrl = (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}/events`

export async function errorFrom(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`
  try {
    const body: unknown = await res.json()
    if (body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string') {
      message = (body as { message: string }).message
    }
  } catch {
    // Non-JSON error body: keep the generic message.
  }
  const retry = Number(res.headers.get('Retry-After'))
  return new ApiError(res.status, message, false, Number.isFinite(retry) && retry > 0 ? retry : undefined)
}

export const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

export async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(path, { ...init, cache: 'no-store' })
  } catch (error) {
    if (isAbort(error)) throw error
    throw new ApiError(0, 'Could not reach the backend.', true)
  }
  if (!res.ok) throw await errorFrom(res)
  try {
    return await res.json()
  } catch (error) {
    if (isAbort(error)) throw error
    throw new ApiError(res.status, 'The backend returned an unreadable response.')
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'

export function parseJobMeta(value: unknown): JobMeta {
  if (isRecord(value)) {
    const { jobId, repoUrl, stage, status, createdAt, updatedAt } = value
    if (
      typeof jobId === 'string' && typeof repoUrl === 'string' && typeof stage === 'string' &&
      typeof status === 'string' && typeof createdAt === 'string' && typeof updatedAt === 'string'
    ) {
      return { jobId, repoUrl, stage, status, createdAt, updatedAt }
    }
  }
  throw new ApiError(200, 'The backend returned unexpected job metadata.')
}

export async function checkHealth(signal: AbortSignal): Promise<{ version: string }> {
  const body = await request('/api/health', { signal })
  if (isRecord(body) && body.status === 'ok') return { version: typeof body.version === 'string' ? body.version : 'unknown' }
  throw new ApiError(200, 'Unexpected health response.')
}

export async function createJob(repoUrl: string, signal?: AbortSignal): Promise<Credential> {
  const body = await request('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoUrl, consent: true }),
    signal,
  })
  if (isRecord(body) && typeof body.jobId === 'string' && isValidToken(body.token)) {
    return { jobId: body.jobId, token: body.token }
  }
  throw new ApiError(200, 'The backend returned an unexpected job response.')
}

export async function getJob(cred: Credential, signal?: AbortSignal): Promise<JobMeta> {
  return parseJobMeta(await request(`/api/jobs/${encodeURIComponent(cred.jobId)}`, { headers: authHeaders(cred.token), signal }))
}

export async function cancelJob(cred: Credential, signal?: AbortSignal): Promise<JobMeta> {
  return parseJobMeta(
    await request(`/api/jobs/${encodeURIComponent(cred.jobId)}/cancel`, { method: 'POST', headers: authHeaders(cred.token), signal }),
  )
}

/** Plain-language message for a failed request. Never includes credentials. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something unexpected went wrong.'
  if (error.network) return 'The backend is unreachable. Check that it is running, then try again.'
  switch (error.status) {
    case 401:
    case 403:
      return 'The saved job credential was not accepted by the backend.'
    case 409:
      return 'The job can no longer be cancelled; it is not queued.'
    case 413:
      return 'The request was too large.'
    case 422:
      return 'The backend rejected the request. Use a public https://github.com/owner/repo URL and confirm consent.'
    case 429:
      return error.retryAfterSeconds
        ? `The backend is busy. Try again in about ${error.retryAfterSeconds} seconds.`
        : 'The backend is rate-limiting requests. Try again shortly.'
    default:
      return error.status >= 500 ? 'The backend reported a server error. Try again shortly.' : error.message
  }
}
