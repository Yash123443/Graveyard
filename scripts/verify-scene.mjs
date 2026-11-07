import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp, unlink, rmdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import ts from 'typescript'
import * as THREE from 'three'

// Exercise real scene geometry in Node; only the canvas gradient texture needs a stub.
const cache = path.resolve('node_modules/.tmp')
await mkdir(cache, { recursive: true })
const temporary = await mkdtemp(path.join(cache, 'scene-check-'))
const generated = []
async function compile(sourcePath, outputName, replace = text => text) {
  const source = replace(await readFile(sourcePath, 'utf8'))
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const file = path.join(temporary, outputName)
  await writeFile(file, output); generated.push(file)
  return import(pathToFileURL(file).href)
}
try {
  const { ritualPower } = await compile('src/animations/ritualPower.ts', 'ritual.mjs')
  for (let i = 0; i < 3; i++) {
    assert.equal(ritualPower(i, 0, 0, 'pending', false), 0, 'Magic must not appear before the encounter')
    assert.ok(ritualPower(i, i * 0.24 + 0.16, 0, 'pending', false) > 0.5, 'Each soul must cast during its own phase')
    assert.ok(ritualPower(i, 0.99, 0, 'pending', false) > 0.9, 'All souls must join the combined ritual')
    assert.equal(ritualPower(i, 1, 0.3, 'failure', true), 0, 'An unverified repair must release its magic')
    assert.ok(ritualPower(i, 1, 0.4, 'success', true) > 0.5, 'Verified success must sustain the convergence')
    assert.equal(ritualPower(i, 1, 1, 'success', true), 0, 'Finished magic must disappear')
    for (let step = 0; step <= 100; step++) {
      const power = ritualPower(i, 1, step / 100, 'success', true)
      assert.ok(Number.isFinite(power) && power >= 0 && power <= 1)
    }
  }
  console.log('Individual casting, combined ritual, and success/failure fades passed.')
  const { soulCue, SOUL_STARTS, advanceStoryProgress } = await compile('src/animations/soulChoreography.ts', 'choreography.mjs')
  for (const start of SOUL_STARTS) {
    for (let i = 0; i <= 240; i++) {
      const cue = soulCue(start + i / 1000, start)
      if (cue.caption > 0.1) assert.ok(cue.entrance > 0.5, 'Caption must not precede the visible soul')
    }
    assert.equal(soulCue(start - 0.01, start).caption, 0)
    assert.equal(soulCue(start + 0.24, start).caption, 0)
  }
  const progressAt = fps => {
    let progress = 0
    for (let i = 0; i < fps * 12; i++) progress = advanceStoryProgress(progress, 1 / fps)
    return progress
  }
  assert.ok(Math.abs(progressAt(30) - progressAt(120)) < 1e-10, 'Story speed must be frame-rate independent')
  assert.ok(advanceStoryProgress(0.2, 10) - 0.2 < 0.002, 'A stall must not skip dialogue')
  const { newGhostEncounter, updateGhostEncounter } = await compile('src/objects/ghostEncounter.ts', 'ghost.mjs')
  const ghost = newGhostEncounter()
  for (let i = 0; i < 210; i++) updateGhostEncounter(ghost, 1 / 60, 15, 0.8, true, 0)
  assert.ok(ghost.opacity > 0.4, 'Ghost should briefly peek at a safe distance')
  for (let i = 0; i < 60; i++) updateGhostEncounter(ghost, 1 / 60, 15 - i * 0.025, 0.8, true, 0)
  assert.equal(ghost.gone, true, 'An approaching observer must banish the ghost')
  for (let i = 0; i < 1200; i++) updateGhostEncounter(ghost, 1 / 60, 20, 0.8, true, 0)
  assert.ok(ghost.gone && ghost.opacity < 0.005, 'Returning to the tree must not restore a banished ghost')
  const closeGhost = newGhostEncounter()
  updateGhostEncounter(closeGhost, 1 / 60, 6, 1, true, 0)
  assert.ok(closeGhost.gone && closeGhost.opacity === 0, 'Ghost must never remain visible at close range')
  const watchedGhost = newGhostEncounter()
  for (let i = 0; i < 240; i++) updateGhostEncounter(watchedGhost, 1 / 60, 15, 1, true, 0)
  assert.equal(watchedGhost.gone, true, 'Deliberate inspection must banish the ghost')
  console.log('Caption timing, frame pacing, and ghost encounter checks passed.')
  const { batchStaticMeshes } = await compile('src/utils/batchStaticMeshes.ts', 'batch.mjs')
  const material = new THREE.MeshStandardMaterial()
  const parent = new THREE.Group(); parent.position.set(7, 2, -4); parent.rotation.y = 0.7
  const nested = new THREE.Group(); nested.position.set(1, 2, 3); parent.add(nested)
  for (let i = 0; i < 4; i++) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), material)
    mesh.position.set(i, i * 0.4, 0); mesh.rotation.z = i * 0.3; nested.add(mesh)
  }
  const animated = new THREE.Group(); parent.add(animated)
  const animatedMesh = new THREE.Mesh(new THREE.SphereGeometry(0.2), material); animated.add(animatedMesh)
  const before = new THREE.Box3().setFromObject(parent)
  batchStaticMeshes(parent, new Set([animated]))
  const after = new THREE.Box3().setFromObject(parent)
  assert.ok(before.min.distanceTo(after.min) < 1e-5 && before.max.distanceTo(after.max) < 1e-5, 'Batching must preserve world bounds')
  assert.equal(animatedMesh.parent, animated, 'Animated subtrees must remain intact')
  assert.equal(parent.children.filter(child => child.isMesh).length, 1, 'Static meshes should share one material batch')

  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} }) }) }
  const { createWitchSoul } = await compile('src/objects/analyst/createWitchSoul.ts', 'soul.mjs', source => source.replace("'../../utils/batchStaticMeshes'", "'./batch.mjs'"))
  for (const variant of ['analyst', 'fixer', 'tester']) {
    const holder = new THREE.Group(), actor = createWitchSoul(holder, { variant, scale: 1.58 })
    let meshes = 0, triangles = 0, disposed = 0
    actor.group.traverse(node => {
      if (!node.isMesh) return
      meshes++; triangles += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3
      assert.ok(Array.from(node.geometry.attributes.position.array).every(Number.isFinite), `${variant}: finite vertices`)
      node.geometry.addEventListener('dispose', () => disposed++)
    })
    assert.ok(meshes <= 20, `${variant}: mesh budget exceeded (${meshes})`)
    assert.ok(triangles < 40000, `${variant}: triangle budget exceeded (${triangles})`)
    actor.set(0, 0); assert.equal(actor.group.visible, false)
    actor.set(12, 1); assert.equal(actor.group.visible, true)
    actor.group.traverse(node => { if (node.isMesh) assert.ok(node.material.opacity >= 0 && node.material.opacity <= 1) })
    actor.set(12, 2, 1, 0); assert.equal(actor.group.visible, false)
    actor.set(12, 3); assert.equal(actor.group.visible, true)
    actor.dispose(); assert.equal(holder.children.length, 0); assert.equal(disposed, meshes)
    console.log(`${variant}: ${meshes} mesh batches, ${triangles} triangles; fade and disposal passed`)
  }
  console.log('Static batching preserves transforms and excludes animated subtrees.')
} finally {
  for (const file of generated) await unlink(file)
  await rmdir(temporary)
}
