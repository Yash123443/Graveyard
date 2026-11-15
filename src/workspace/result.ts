import type { ResultView } from './api'

/**
 * Pure presentation model for `GET /api/jobs/:id/result`. No DOM, no network. Everything shown is
 * read defensively from the stored result: unknown or malformed parts are simply left out, and a
 * repair is only called verified when the outcome, the flag, the diff and the verification record
 * all agree (the backend already re-checks its sha256; this is the second, independent gate).
 */

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral'

export interface StageRow {
  stage: string
  status: string
  exitCode: number | null
  durationMs: number | null
}

export interface DiagnosisModel {
  category: string
  summary: string
  rootCause: string
  confidence: string
  files: string[]
}

export interface ProposalModel {
  summary: string
  diff: string
  files: string[]
  added: number | null
  removed: number | null
}

export interface VerificationModel {
  status: string
  reason: string
  detail: string
  measuredMs: number | null
  pipelineMs: number | null
}

export interface ResultModel {
  outcome: string
  headline: string
  tone: Tone
  /** Fixed text from the backend. */
  summary: string
  /** True only for a repair whose verification record the UI could confirm. */
  verified: boolean
  baselineStages: StageRow[]
  patchedStages: StageRow[]
  diagnosis: DiagnosisModel | null
  proposal: ProposalModel | null
  verification: VerificationModel | null
  /** The exact verified diff, only when `verified` is true. */
  verifiedDiff: string | null
  findings: string[]
  infrastructure: string | null
  notes: string[]
}

const HEADLINES: Record<string, { text: string; tone: Tone }> = {
  pending: { text: 'Not finished', tone: 'neutral' },
  passing: { text: 'Passing: the original needed no repair', tone: 'ok' },
  'repair-verified': { text: 'Repair verified in a disposable copy', tone: 'ok' },
  'patch-failed-verification': { text: 'Patch tested and still failing', tone: 'bad' },
  'failing-with-patch-proposal': { text: 'Failing: unverified patch proposal', tone: 'warn' },
  'failing-with-diagnosis': { text: 'Failing: diagnosis only', tone: 'warn' },
  'failing-undiagnosed': { text: 'Failing: no diagnosis, nothing repaired', tone: 'bad' },
  'tests-not-run': { text: 'Build passed, tests did not run', tone: 'warn' },
  'unsupported-repository': { text: 'Outside the supported class, nothing built', tone: 'neutral' },
  'infrastructure-failed': { text: 'Could not be evaluated (infrastructure)', tone: 'neutral' },
  'timed-out': { text: 'Timed out (infrastructure)', tone: 'neutral' },
  cancelled: { text: 'Cancelled', tone: 'neutral' },
  'completed-without-result': { text: 'Completed without a valid result', tone: 'warn' },
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max = 4000): string | null => (typeof v === 'string' ? v.slice(0, max) : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strings = (v: unknown, max = 20): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max).map((x) => x.slice(0, 200)) : []

function stagesOf(v: unknown): StageRow[] {
  const raw = isRecord(v) ? v.stages : null
  if (!Array.isArray(raw)) return []
  const rows: StageRow[] = []
  for (const s of raw.slice(0, 8)) {
    if (!isRecord(s)) continue
    const stage = str(s.stage, 40)
    const status = str(s.status, 40)
    if (stage === null || status === null) continue
    rows.push({ stage, status, exitCode: num(s.exitCode), durationMs: num(s.durationMs) })
  }
  return rows
}

function diagnosisOf(v: unknown): DiagnosisModel | null {
  if (!isRecord(v) || v.status !== 'ok') return null
  const summary = str(v.summary, 600)
  const rootCause = str(v.rootCause, 1500)
  if (summary === null || rootCause === null) return null
  return { category: str(v.category, 60) ?? 'other', summary, rootCause, confidence: str(v.confidence, 20) ?? 'unknown', files: strings(v.affectedFiles) }
}

function proposalOf(v: unknown): ProposalModel | null {
  if (!isRecord(v) || v.status !== 'ok') return null
  const diff = str(v.diff, 40000)
  if (diff === null || diff === '') return null
  return { summary: str(v.summary, 600) ?? '', diff, files: strings(v.files), added: num(v.added), removed: num(v.removed) }
}

function verificationOf(v: unknown): VerificationModel | null {
  if (!isRecord(v)) return null
  const status = str(v.status, 40)
  if (status === null) return null
  return {
    status,
    reason: str(v.reason, 80) ?? '',
    detail: str(v.detail, 600) ?? '',
    measuredMs: num(v.measuredMs),
    pipelineMs: num(v.pipelineMs),
  }
}

/** The diff is offered for saving only when every independent signal agrees that the repair was verified. */
function confirmedDiff(view: ResultView, result: Record<string, unknown> | null): string | null {
  if (view.outcome !== 'repair-verified' || view.repair.verified !== true) return null
  if (typeof view.verifiedDiff !== 'string' || view.verifiedDiff === '') return null
  if (result === null) return null
  const v = result.verification
  if (!isRecord(v) || v.status !== 'verified' || v.originalModified !== false) return null
  const patched = v.patched
  if (!isRecord(patched) || patched.status !== 'success') return null
  return view.verifiedDiff
}

export function buildResultModel(view: ResultView): ResultModel {
  const head = HEADLINES[view.outcome] ?? { text: 'Unrecognised result', tone: 'warn' as Tone }
  const result = view.result
  const diff = confirmedDiff(view, result)
  const verification = result === null ? null : verificationOf(result.verification)
  const patched = result !== null && isRecord(result.verification) ? stagesOf(result.verification.patched) : []
  const analysis = result !== null && isRecord(result.analysis) ? result.analysis : null
  const findings: string[] = []
  if (analysis !== null && Array.isArray(analysis.findings)) {
    for (const f of analysis.findings.slice(0, 12)) {
      if (!isRecord(f)) continue
      const code = str(f.code, 60)
      const detail = str(f.detail, 240)
      if (code !== null) findings.push(detail === null ? code : `${code}: ${detail}`)
    }
  }
  return {
    outcome: view.outcome,
    headline: diff !== null ? head.text : view.outcome === 'repair-verified' ? 'Repair claim could not be confirmed' : head.text,
    tone: diff !== null ? head.tone : view.outcome === 'repair-verified' ? 'warn' : head.tone,
    summary:
      view.outcome === 'repair-verified' && diff === null
        ? 'The backend reported a verified repair, but this page could not confirm the verification record. Treat it as unverified; no diff is offered.'
        : view.summary,
    verified: diff !== null,
    baselineStages: result === null ? [] : stagesOf(result.pipeline),
    patchedStages: patched,
    diagnosis: result === null ? null : diagnosisOf(result.analyst),
    proposal: result === null ? null : proposalOf(result.fixer),
    verification,
    verifiedDiff: diff,
    findings,
    infrastructure: view.infrastructure ? `${view.infrastructure.kind}: ${view.infrastructure.message}`.slice(0, 400) : null,
    notes: result === null ? [] : strings(result.notes, 6),
  }
}

/** Plain, safe file name for the saved diff. Derived from the job id, never from repository text. */
export function diffFileName(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)
  return `graveyard-${safe || 'job'}-build.mjs.diff`
}
