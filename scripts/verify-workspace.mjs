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

  console.log('Workspace SSE parser and error classification checks passed.')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
