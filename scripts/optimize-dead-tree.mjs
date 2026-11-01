import { readFile, writeFile } from 'node:fs/promises'
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'

const sourcePath = 'scripts/assets-source/dead-tree.glb'
const outputPath = 'public/models/dead-tree.glb'
const input = await readFile(sourcePath)
const jsonLength = input.readUInt32LE(12)
const json = JSON.parse(input.toString('utf8', 20, 20 + jsonLength).trim())
const binHeader = 20 + jsonLength
const binLength = input.readUInt32LE(binHeader)
const originalBin = input.subarray(binHeader + 8, binHeader + 8 + binLength)

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready])

const readDecodedView = (viewIndex) => {
  const extension = json.bufferViews[viewIndex].extensions.EXT_meshopt_compression
  const bytes = originalBin.subarray(extension.byteOffset, extension.byteOffset + extension.byteLength)
  const output = new Uint8Array(extension.count * extension.byteStride)
  MeshoptDecoder.decodeGltfBuffer(output, extension.count, extension.byteStride, bytes, extension.mode, extension.filter)
  return { extension, output }
}

const indexSource = readDecodedView(3)
const positionSource = readDecodedView(5)
const originalVertexCount = positionSource.extension.count
const originalIndices = new Uint32Array(indexSource.output.buffer)
const quantizedPositions = new Int16Array(positionSource.output.buffer)
const positions = new Float32Array(positionSource.extension.count * 3)
for (let i = 0; i < positionSource.extension.count; i++) {
  positions[i * 3] = quantizedPositions[i * 4] / 32767
  positions[i * 3 + 1] = quantizedPositions[i * 4 + 1] / 32767
  positions[i * 3 + 2] = quantizedPositions[i * 4 + 2] / 32767
}

const targetIndexCount = Math.floor(originalIndices.length * 0.22 / 3) * 3
const [simplifiedIndices, error] = MeshoptSimplifier.simplify(originalIndices, positions, 3, targetIndexCount, 0.01)
if (simplifiedIndices.length < 3 || simplifiedIndices.length >= originalIndices.length) throw new Error('Simplification did not produce a smaller triangle mesh')
const [vertexRemap, compactVertexCount] = MeshoptSimplifier.compactMesh(simplifiedIndices)

const simplifiedIndexBytes = new Uint8Array(simplifiedIndices.buffer, simplifiedIndices.byteOffset, simplifiedIndices.byteLength)
const compressedIndices = MeshoptEncoder.encodeGltfBuffer(simplifiedIndexBytes, simplifiedIndices.length, 4, 'TRIANGLES')
const attributeViews = [4, 5, 6].map(readDecodedView)
const compactAttributes = attributeViews.map(({ extension, output }) => {
  const compact = new Uint8Array(compactVertexCount * extension.byteStride)
  for (let oldIndex = 0; oldIndex < vertexRemap.length; oldIndex++) {
    const newIndex = vertexRemap[oldIndex]
    if (newIndex === 0xffffffff) continue
    compact.set(output.subarray(oldIndex * extension.byteStride, (oldIndex + 1) * extension.byteStride), newIndex * extension.byteStride)
  }
  return compact
})
const compressedAttributes = attributeViews.map(({ extension }, i) =>
  MeshoptEncoder.encodeGltfBuffer(compactAttributes[i], compactVertexCount, extension.byteStride, 'ATTRIBUTES'))
const imageEnd = Math.max(...json.bufferViews.slice(0, 3).map((view) => view.byteOffset + view.byteLength))
const compressedParts = [Buffer.from(originalBin.subarray(0, imageEnd))]
let compressedOffset = compressedParts[0].length
while (compressedOffset % 4) { compressedParts.push(Buffer.from([0])); compressedOffset += 1 }
const newIndexOffset = compressedOffset
compressedParts.push(Buffer.from(compressedIndices))
compressedOffset += compressedIndices.byteLength
while (compressedOffset % 4) { compressedParts.push(Buffer.from([0])); compressedOffset += 1 }

json.bufferViews[3].buffer = 1
json.bufferViews[3].byteOffset = 0
json.bufferViews[3].byteLength = simplifiedIndexBytes.byteLength
json.bufferViews[3].extensions.EXT_meshopt_compression = {
  buffer: 0, byteOffset: newIndexOffset, byteLength: compressedIndices.byteLength,
  mode: 'TRIANGLES', byteStride: 4, count: simplifiedIndices.length,
}
json.accessors[0].count = simplifiedIndices.length
for (const accessorIndex of [1, 2, 3]) json.accessors[accessorIndex].count = compactVertexCount

let fallbackOffset = simplifiedIndexBytes.byteLength
for (let i = 0; i < attributeViews.length; i++) {
  const view = json.bufferViews[4 + i]
  const decoded = attributeViews[i]
  view.buffer = 1
  view.byteOffset = fallbackOffset
  view.byteLength = compactAttributes[i].byteLength
  view.extensions.EXT_meshopt_compression.byteLength = compressedAttributes[i].byteLength
  view.extensions.EXT_meshopt_compression.byteOffset = compressedOffset
  view.extensions.EXT_meshopt_compression.count = compactVertexCount
  delete view.extensions.EXT_meshopt_compression.filter
  compressedParts.push(Buffer.from(compressedAttributes[i]))
  compressedOffset += compressedAttributes[i].byteLength
  while (compressedOffset % 4) { compressedParts.push(Buffer.from([0])); compressedOffset += 1 }
  fallbackOffset += compactAttributes[i].byteLength
}

const compressedBin = Buffer.concat(compressedParts)
const fallbackBinLength = fallbackOffset
json.buffers[0].byteLength = compressedBin.byteLength
json.buffers[1].byteLength = fallbackBinLength

const expectedBuffers = [simplifiedIndexBytes, ...compactAttributes]
for (const [i, viewIndex] of [3, 4, 5, 6].entries()) {
  const extension = json.bufferViews[viewIndex].extensions.EXT_meshopt_compression
  const source = compressedBin.subarray(extension.byteOffset, extension.byteOffset + extension.byteLength)
  const decoded = new Uint8Array(extension.count * extension.byteStride)
  MeshoptDecoder.decodeGltfBuffer(decoded, extension.count, extension.byteStride, source, extension.mode, extension.filter)
  if (i === 0) {
    const expected = new Uint32Array(expectedBuffers[i].buffer, expectedBuffers[i].byteOffset, simplifiedIndices.length)
    const actual = new Uint32Array(decoded.buffer)
    const canonical = (indices, offset) => {
      const a = indices[offset], b = indices[offset + 1], c = indices[offset + 2]
      return [
        `${a},${b},${c}`, `${b},${c},${a}`, `${c},${a},${b}`,
      ].sort()[0]
    }
    const triangles = new Map()
    for (let triangle = 0; triangle < expected.length; triangle += 3) {
      const key = canonical(expected, triangle)
      triangles.set(key, (triangles.get(key) ?? 0) + 1)
    }
    for (let triangle = 0; triangle < actual.length; triangle += 3) {
      const key = canonical(actual, triangle)
      const count = triangles.get(key)
      if (!count) throw new Error('Simplified index stream changed triangle topology or winding')
      if (count === 1) triangles.delete(key)
      else triangles.set(key, count - 1)
    }
    if (triangles.size) throw new Error('Simplified index stream lost triangles while encoding')
  } else if (Buffer.compare(Buffer.from(decoded), Buffer.from(expectedBuffers[i])) !== 0) {
    const mismatch = decoded.findIndex((byte, index) => byte !== expectedBuffers[i][index])
    throw new Error(`Meshopt stream ${viewIndex} did not round-trip cleanly at byte ${mismatch}: ${decoded[mismatch]} vs ${expectedBuffers[i][mismatch]}`)
  }
}
let maximumIndex = 0
for (const index of simplifiedIndices) if (index > maximumIndex) maximumIndex = index
if (maximumIndex >= compactVertexCount) throw new Error('Simplified indices reference a missing vertex')

const jsonChunk = Buffer.from(JSON.stringify(json))
const jsonPadding = (4 - jsonChunk.length % 4) % 4
const paddedJson = Buffer.concat([jsonChunk, Buffer.alloc(jsonPadding, 0x20)])
const binPadding = (4 - compressedBin.length % 4) % 4
const paddedBin = Buffer.concat([compressedBin, Buffer.alloc(binPadding)])
const output = Buffer.alloc(12 + 8 + paddedJson.length + 8 + paddedBin.length)
output.write('glTF', 0)
output.writeUInt32LE(2, 4)
output.writeUInt32LE(output.length, 8)
output.writeUInt32LE(paddedJson.length, 12)
output.writeUInt32LE(0x4e4f534a, 16)
paddedJson.copy(output, 20)
const binHeaderOffset = 20 + paddedJson.length
output.writeUInt32LE(paddedBin.length, binHeaderOffset)
output.writeUInt32LE(0x004e4942, binHeaderOffset + 4)
paddedBin.copy(output, binHeaderOffset + 8)
await writeFile(outputPath, output)
console.log(JSON.stringify({
  sourceBytes: input.byteLength,
  optimizedBytes: output.byteLength,
  originalTriangles: originalIndices.length / 3,
  optimizedTriangles: simplifiedIndices.length / 3,
  originalVertices: originalVertexCount,
  optimizedVertices: compactVertexCount,
  targetError: 0.01,
  measuredError: error,
}))
