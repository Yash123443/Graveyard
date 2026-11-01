/** Contract for the repair service to send after its repair and verification jobs finish. */
export interface RepairResult {
  repositoryName: string
  rootCause: string
  breakingDependency: string
  breakingVersion: string
  repairsAttempted: string[]
  changesMade: string[]
  buildResult: 'passed' | 'failed' | 'not-run'
  testResult: 'passed' | 'failed' | 'not-run'
  verificationResult: 'passed' | 'failed' | 'not-run'
  finalStatus: 'success' | 'failed' | 'partial'
}

const RESULT_EVENT = 'graveyard:repair-result'
let latest: RepairResult | null = null
const listeners = new Set<() => void>()

export function getRepairResult() { return latest }
export function subscribeRepairResult(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function isRepairResult(value: unknown): value is RepairResult {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<RepairResult>
  return typeof data.repositoryName === 'string'
    && typeof data.rootCause === 'string'
    && typeof data.breakingDependency === 'string'
    && typeof data.breakingVersion === 'string'
    && Array.isArray(data.repairsAttempted) && data.repairsAttempted.every((x) => typeof x === 'string')
    && Array.isArray(data.changesMade) && data.changesMade.every((x) => typeof x === 'string')
    && ['passed', 'failed', 'not-run'].includes(data.buildResult ?? '')
    && ['passed', 'failed', 'not-run'].includes(data.testResult ?? '')
    && ['passed', 'failed', 'not-run'].includes(data.verificationResult ?? '')
    && ['success', 'failed', 'partial'].includes(data.finalStatus ?? '')
}

function acceptResult(value: unknown) {
  if (!isRepairResult(value)) return
  latest = Object.freeze({ ...value, repairsAttempted: [...value.repairsAttempted], changesMade: [...value.changesMade] })
  listeners.forEach((listener) => listener())
  window.dispatchEvent(new Event('graveyard:repair-result-accepted'))
}

if (typeof window !== 'undefined') {
  window.addEventListener(RESULT_EVENT, (event) => acceptResult((event as CustomEvent<unknown>).detail))
}

/** A happy ending requires positive repair, build, test, and verification results from the backend. */
export function isVerifiedRepair(result: RepairResult | null): result is RepairResult {
  return !!result
    && result.finalStatus === 'success'
    && result.buildResult === 'passed'
    && result.testResult === 'passed'
    && result.verificationResult === 'passed'
}

declare global {
  interface Window {
    /** Backend integration hook: dispatch a fully populated RepairResult after verification. */
    dispatchRepairResult?: (result: RepairResult) => void
  }
}

if (typeof window !== 'undefined') {
  window.dispatchRepairResult = (result) => acceptResult(result)
}
