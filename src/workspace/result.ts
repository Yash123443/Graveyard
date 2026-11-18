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

export interface StaticAuditModel {
  /** Backend scope statement (what was read and checked). Not a finding. */
  scope: string | null
  /** Actual problems, text only, without the machine code. */
  problems: string[]
  /** Total problems, only when exactly derivable from the listed problems plus the validated omitted count. */
  total: number | null
  /** Problems found but not listed (validated count), or 0. */
  omitted: number
}

export interface InspectionModel {
  /** Lowercase 40-hex commit the HEAD resolved to, or null when none was recorded. */
  commit: string | null
  /** Root-file profile the backend checked against ('npm-scripts'), or null for the default root build.mjs check. */
  profile: string | null
  /** npm-scripts root checks outcome (true/false), or null when no such check was reported. Always preliminary. */
  rootChecksPassed: boolean | null
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
  staticAudit: StaticAuditModel | null
  /** Unpinned source inspection facts (outcome `source-inspected` only). */
  inspection: InspectionModel | null
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
  'static-site-audited': { text: 'Static site audit complete', tone: 'neutral' },
  'source-inspected': { text: 'Repository source inspected', tone: 'neutral' },
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

const STATIC_PROBLEM_CODES: ReadonlySet<string> = new Set([
  'missing-local-page',
  'missing-local-asset',
  'case-mismatch-reference',
  'reference-escapes-site-root',
  'unsafe-reference-path',
  'base-href-not-audited',
])
const STATIC_MAX_FINDINGS = 60

/**
 * Separates the single scope statement from the actual problems. The total is given only when the
 * listing is well formed (one scope entry, known codes, within the backend cap) and the omitted
 * count is a validated non-negative integer: total = listed problems + omitted.
 */
function staticAuditOf(result: Record<string, unknown> | null): StaticAuditModel | null {
  if (result === null) return null
  const analysis = isRecord(result.analysis) ? result.analysis : null
  const raw = analysis !== null && Array.isArray(analysis.findings) ? analysis.findings : null
  if (raw === null) return null
  let scope: string | null = null
  let scopeCount = 0
  let wellFormed = raw.length <= STATIC_MAX_FINDINGS
  const problems: string[] = []
  for (const f of raw.slice(0, STATIC_MAX_FINDINGS)) {
    if (!isRecord(f)) { wellFormed = false; continue }
    const code = str(f.code, 60)
    const detail = str(f.detail, 400)
    if (code === null || detail === null) { wellFormed = false; continue }
    if (code === 'static-site-scope') {
      scopeCount += 1
      scope = detail
    } else if (STATIC_PROBLEM_CODES.has(code)) {
      problems.push(detail)
    } else {
      wellFormed = false
    }
  }
  const audit = isRecord(result.audit) ? result.audit : null
  const omittedRaw = audit === null ? null : audit.findingsOmitted
  const omittedValid = typeof omittedRaw === 'number' && Number.isInteger(omittedRaw) && omittedRaw >= 0 && omittedRaw <= 100000
  const total = wellFormed && scopeCount === 1 && omittedValid ? problems.length + (omittedRaw as number) : null
  return { scope: scopeCount === 1 ? scope : null, problems, total, omitted: omittedValid ? (omittedRaw as number) : 0 }
}

function inspectionOf(result: Record<string, unknown> | null): InspectionModel | null {
  if (result === null) return null
  const source = isRecord(result.source) ? result.source : null
  const commit = source !== null && typeof source.commit === 'string' && /^[0-9a-f]{40}$/.test(source.commit) ? source.commit : null
  const analysis = isRecord(result.analysis) ? result.analysis : null
  const profile = analysis !== null && analysis.profile === 'npm-scripts' ? 'npm-scripts' : null
  const checks = profile !== null && analysis !== null && isRecord(analysis.rootChecks) ? analysis.rootChecks : null
  const rootChecksPassed = checks !== null && checks.preliminary === true && typeof checks.passed === 'boolean' ? checks.passed : null
  return { commit, profile, rootChecksPassed }
}

export function buildResultModel(view: ResultView): ResultModel {
  const head = HEADLINES[view.outcome] ?? { text: 'Unrecognised result', tone: 'warn' as Tone }
  const result = view.result
  const diff = confirmedDiff(view, result)
  const verification = result === null ? null : verificationOf(result.verification)
  const patched = result !== null && isRecord(result.verification) ? stagesOf(result.verification.patched) : []
  const analysis = result !== null && isRecord(result.analysis) ? result.analysis : null
  const staticAudit = view.outcome === 'static-site-audited' ? staticAuditOf(result) : null
  const findings: string[] = []
  if (staticAudit === null && analysis !== null && Array.isArray(analysis.findings)) {
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
    staticAudit,
    inspection: view.outcome === 'source-inspected' ? inspectionOf(result) : null,
    infrastructure: view.infrastructure ? `${view.infrastructure.kind}: ${view.infrastructure.message}`.slice(0, 400) : null,
    notes: result === null ? [] : strings(result.notes, 6),
  }
}

/** A root-level script file name only: no path, no leading dot, one extension of .js, .mjs or .cjs. */
const SAFE_TARGET = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}\.(?:js|mjs|cjs)$/

/**
 * Plain, safe file name for the saved diff. Derived from the job id and, only if it matches a
 * simple safe root filename grammar, the proposed target. Anything else falls back to build.mjs.
 */
export function diffFileName(jobId: string, target?: string | null): string {
  const safe = jobId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)
  const name = typeof target === 'string' && SAFE_TARGET.test(target) ? target : 'build.mjs'
  return `graveyard-${safe || 'job'}-${name}.diff`
}
