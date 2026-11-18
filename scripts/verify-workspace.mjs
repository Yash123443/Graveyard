import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import ts from 'typescript'

// Dependency-free checks for the workspace SSE parser and error classification.
// Run: node scripts/verify-workspace.mjs
const cache = path.resolve('node_modules/.tmp')
await mkdir(cache, { recursive: true })
const temporary = await mkdtemp(path.join(cache, 'workspace-check-'))
async function compile(sourcePath, outputName) {
  const source = await readFile(sourcePath, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const file = path.join(temporary, outputName)
  await writeFile(file, output)
  return import(pathToFileURL(file).href)
}

try {
  const { createSseParser } = await compile('src/workspace/sse.ts', 'sse.mjs')
  const { ApiError, isTransient, looksLikeRepoUrl, isValidToken, describeError } = await compile('src/workspace/api.ts', 'api.mjs')

  const parse = (chunks) => {
    const messages = []
    const comments = []
    const parser = createSseParser((m) => messages.push(m), (c) => comments.push(c))
    for (const chunk of chunks) parser.push(chunk)
    parser.end()
    return { messages, comments }
  }
  const stream = 'id: 1\nevent: created\ndata: {"a":1}\n\n: heartbeat\n\nid: 2\nevent: cancelled\ndata: {"status":\ndata: "cancelled"}\n\n'

  // Whole stream, LF.
  let r = parse([stream])
  assert.deepEqual(r.messages.map((m) => [m.id, m.event]), [['1', 'created'], ['2', 'cancelled']])
  assert.equal(r.messages[1].data, '{"status":\n"cancelled"}', 'multiline data joins with LF')
  assert.deepEqual(r.comments, [' heartbeat'])

  // CRLF and bare CR produce identical messages.
  for (const eol of ['\r\n', '\r']) {
    const converted = stream.replaceAll('\n', eol)
    assert.deepEqual(parse([converted]).messages, r.messages, `eol ${JSON.stringify(eol)}`)
  }

  // Every possible chunk boundary, including between CR and LF, yields the same result.
  for (const eol of ['\n', '\r\n', '\r']) {
    const text = stream.replaceAll('\n', eol)
    for (let i = 0; i <= text.length; i++) {
      assert.deepEqual(parse([text.slice(0, i), text.slice(i)]).messages, r.messages, `split ${i} eol ${JSON.stringify(eol)}`)
    }
    assert.deepEqual(parse([...text]).messages, r.messages, `char-by-char eol ${JSON.stringify(eol)}`)
  }

  // BOM, optional space after colon, id stickiness, default event name, no-data events dropped.
  r = parse(['\uFEFFdata:no-space\n\n', 'event: x\n\n', 'id: 7\ndata: a\n\n', 'data: b\n\n'])
  assert.deepEqual(r.messages.map((m) => [m.id, m.event, m.data]), [[undefined, 'message', 'no-space'], ['7', 'message', 'a'], ['7', 'message', 'b']])

  // Incomplete trailing event is discarded; ids containing NUL are ignored; retry is ignored.
  r = parse(['id: 1\ndata: done\n\nid: 2\ndata: partial'])
  assert.deepEqual(r.messages.map((m) => m.id), ['1'])
  r = parse(['id: a\0b\nretry: 5\ndata: x\n\n'])
  assert.equal(r.messages[0].id, undefined)

  // Multi-byte text split across chunks is the caller's decoder job; parser keeps text intact.
  assert.equal(parse(['data: gr', 'ave 🪦\n', '\n']).messages[0].data, 'grave 🪦')

  // Error classification: only network failures and 5xx are retried.
  assert.equal(isTransient(new ApiError(0, 'x', true)), true)
  assert.equal(isTransient(new ApiError(503, 'x')), true)
  for (const status of [400, 401, 403, 404, 422, 429]) assert.equal(isTransient(new ApiError(status, 'x')), false, String(status))
  assert.equal(isTransient(new Error('x')), false)
  assert.match(describeError(new ApiError(422, 'x')), /github\.com\/owner\/repo/)
  assert.match(describeError(new ApiError(429, 'x', false, 5)), /5 seconds/)

  // Input checks.
  assert.ok(looksLikeRepoUrl('https://github.com/owner/repo'))
  for (const bad of ['http://github.com/o/r', 'https://github.com/o', 'https://github.com/o/r/x', 'https://user@github.com/o/r', 'https://github.com/o/r?x=1']) {
    assert.ok(!looksLikeRepoUrl(bad), bad)
  }
  assert.ok(isValidToken('a'.repeat(64)) && !isValidToken('A'.repeat(64)) && !isValidToken('a'.repeat(63)))

  // Result presentation: a repair is only "verified" when every independent signal agrees.
  const { parseResultView } = await compile('src/workspace/api.ts', 'api2.mjs')
  const { buildResultModel, diffFileName } = await compile('src/workspace/result.ts', 'result.mjs')
  const DIFF = '--- a/build.mjs\n+++ b/build.mjs\n@@ -1 +1 @@\n-x\n+y\n'
  const stages = (s) => [{ stage: 'prepare', status: 'passed' }, { stage: 'build', status: s, exitCode: s === 'failed' ? 1 : 0, durationMs: 5 }]
  const verifiedResult = () => ({
    verdict: 'repository-failing',
    pipeline: { status: 'failure', stages: stages('failed') },
    analyst: { status: 'ok', category: 'build-failure', summary: 's', rootCause: 'r', confidence: 'high', affectedFiles: ['build.mjs'] },
    fixer: { status: 'ok', summary: 'p', diff: DIFF, files: ['build.mjs'], added: 1, removed: 1 },
    verification: { status: 'verified', reason: 'all-stages-passed', detail: 'd', originalModified: false, measuredMs: 1500, pipelineMs: 900, patched: { status: 'success', stages: stages('passed') } },
    notes: ['n'],
  })
  const view = (over = {}) => parseResultView({
    jobId: 'job1', status: 'completed', stage: 'done', terminal: true, outcome: 'repair-verified', summary: 'server text',
    repair: { verified: true, patchApplied: false, patchProposed: true, diagnosed: true }, verifiedDiff: DIFF,
    result: verifiedResult(), infrastructure: null, ...over,
  })
  let m = buildResultModel(view())
  assert.equal(m.verified, true)
  assert.equal(m.verifiedDiff, DIFF)
  assert.equal(m.tone, 'ok')
  assert.equal(m.baselineStages.length, 2)
  assert.equal(m.patchedStages.length, 2)
  assert.equal(m.verification.measuredMs, 1500)
  assert.equal(m.diagnosis.category, 'build-failure')
  // Any missing signal removes the diff and the claim.
  for (const over of [
    { repair: { verified: false, patchApplied: false, patchProposed: true, diagnosed: true } },
    { verifiedDiff: null },
    { verifiedDiff: '' },
    { outcome: 'failing-with-patch-proposal' },
    { result: { ...verifiedResult(), verification: { ...verifiedResult().verification, status: 'tested-failing' } } },
    { result: { ...verifiedResult(), verification: { ...verifiedResult().verification, originalModified: true } } },
    { result: { ...verifiedResult(), verification: { ...verifiedResult().verification, patched: { status: 'failure' } } } },
    { result: null },
  ]) {
    m = buildResultModel(view(over))
    assert.equal(m.verified, false, JSON.stringify(over).slice(0, 80))
    assert.equal(m.verifiedDiff, null)
  }
  m = buildResultModel(view({ verifiedDiff: null }))
  assert.match(m.summary, /could not confirm/)
  assert.equal(m.tone, 'warn')
  // Unverified outcomes never offer a diff even though a proposal is shown.
  m = buildResultModel(view({ outcome: 'failing-with-patch-proposal', repair: { verified: false, patchApplied: false, patchProposed: true, diagnosed: true }, verifiedDiff: null }))
  assert.equal(m.verifiedDiff, null)
  assert.equal(m.proposal.diff, DIFF)
  // Malformed payloads are rejected or ignored, never thrown into the page.
  assert.throws(() => parseResultView({ jobId: 1 }))
  assert.throws(() => parseResultView(null))
  m = buildResultModel(view({ outcome: 'something-new', result: { fixer: 5, pipeline: { stages: 'x' }, notes: 'x' } }))
  assert.equal(m.verified, false)
  assert.deepEqual(m.baselineStages, [])
  assert.match(diffFileName('a/b\\..'), /^graveyard-ab-build\.mjs\.diff$/)
  assert.match(diffFileName('!!'), /^graveyard-job-build\.mjs\.diff$/)

  // Unpinned source inspection: resolved commit and npm-scripts profile shown, never a repair or a diff.
  const SHA = 'c'.repeat(40)
  const inspected = (analysis, source = { repoUrl: 'https://github.com/x/y', commit: SHA, resolvedFrom: 'HEAD', pinned: false }) => view({
    outcome: 'source-inspected',
    repair: { verified: false, patchApplied: false, patchProposed: false, diagnosed: false },
    verifiedDiff: null,
    result: { verdict: 'source-inspected', sourceKind: 'github-unpinned-head', executed: false, source, analysis, notes: ['n1'] },
  })
  m = buildResultModel(inspected({ pinnedFlowCompatible: true, findings: [], profile: 'npm-scripts', rootChecks: { passed: true, preliminary: true } }))
  assert.deepEqual(m.inspection, { commit: SHA, profile: 'npm-scripts', rootChecksPassed: true })
  assert.equal(m.verified, false)
  assert.equal(m.verifiedDiff, null)
  m = buildResultModel(inspected({ pinnedFlowCompatible: false, findings: [{ code: 'lifecycle-hook-script', detail: 'scripts.prebuild exists.' }], profile: 'npm-scripts', rootChecks: { passed: false, preliminary: true } }))
  assert.deepEqual(m.inspection, { commit: SHA, profile: 'npm-scripts', rootChecksPassed: false })
  assert.deepEqual(m.findings, ['lifecycle-hook-script: scripts.prebuild exists.'])
  // Default root build.mjs check: no profile, no root-check claim. A non-preliminary pass is ignored.
  m = buildResultModel(inspected({ pinnedFlowCompatible: false, findings: [{ code: 'no-build-script', detail: 'd' }] }))
  assert.deepEqual(m.inspection, { commit: SHA, profile: null, rootChecksPassed: null })
  m = buildResultModel(inspected({ findings: [], profile: 'npm-scripts', rootChecks: { passed: true } }))
  assert.equal(m.inspection.rootChecksPassed, null)
  // Malformed commit is not shown; other outcomes carry no inspection.
  m = buildResultModel(inspected({ findings: [] }, { commit: 'main' }))
  assert.equal(m.inspection.commit, null)
  assert.equal(buildResultModel(view()).inspection, null)

  console.log('Workspace SSE parser, error classification and result presentation checks passed.')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
