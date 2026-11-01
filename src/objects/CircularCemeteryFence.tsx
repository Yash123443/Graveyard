import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { createRustTextures } from '../utils/proceduralTextures'

export const CEMETERY_CENTER_Z = -43
export const CEMETERY_FENCE_RADIUS = 56
export const CEMETERY_ROAM_RADIUS = 54.5

const PICKET_COUNT = 224
const PILLAR_EVERY = 8
const ENTRY_HALF_ANGLE = 0.13

function fenceArc(height: number) {
  const points = Array.from({ length: 221 }, (_, index) => {
    const angle = ENTRY_HALF_ANGLE + (index / 220) * (Math.PI * 2 - ENTRY_HALF_ANGLE * 2)
    return new THREE.Vector3(Math.sin(angle) * CEMETERY_FENCE_RADIUS, height, CEMETERY_CENTER_Z + Math.cos(angle) * CEMETERY_FENCE_RADIUS)
  })
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal')
  return new THREE.TubeGeometry(curve, 440, height < 1 ? 0.075 : 0.09, 8, false)
}

/** A continuous, old iron ring closes the playable grounds behind the entry gate. */
export function CircularCemeteryFence() {
  const pickets = useRef<THREE.InstancedMesh>(null)
  const spears = useRef<THREE.InstancedMesh>(null)
  const pillars = useRef<THREE.InstancedMesh>(null)
  const { picketGeometry, spearGeometry, pillarGeometry, material, lowerRail, upperRail } = useMemo(() => {
    const rust = createRustTextures(256)
    return {
      picketGeometry: new THREE.CylinderGeometry(0.037, 0.052, 1.72, 7),
      spearGeometry: new THREE.ConeGeometry(0.09, 0.28, 7),
      pillarGeometry: new THREE.CylinderGeometry(0.1, 0.14, 2.05, 9),
      material: new THREE.MeshStandardMaterial({ map: rust.map, bumpMap: rust.bumpMap, bumpScale: 0.35, color: '#75614d', metalness: 0.58, roughness: 0.83 }),
      lowerRail: fenceArc(0.56),
      upperRail: fenceArc(1.52),
    }
  }, [])

  useLayoutEffect(() => {
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const scale = new THREE.Vector3(1, 1, 1)
    const quaternion = new THREE.Quaternion()
    const axis = new THREE.Vector3(0, 1, 0)
    const direction = new THREE.Vector3()
    let picketIndex = 0
    let pillarIndex = 0
    for (let index = 0; index < PICKET_COUNT; index += 1) {
      const angle = (index / PICKET_COUNT) * Math.PI * 2
      const wrappedAngle = Math.atan2(Math.sin(angle), Math.cos(angle))
      if (Math.abs(wrappedAngle) < ENTRY_HALF_ANGLE) continue
      const x = Math.sin(angle) * CEMETERY_FENCE_RADIUS
      const z = CEMETERY_CENTER_Z + Math.cos(angle) * CEMETERY_FENCE_RADIUS
      position.set(x, 1.03, z)
      matrix.compose(position, quaternion, scale)
      pickets.current?.setMatrixAt(picketIndex, matrix)
      position.set(x, 1.99, z)
      quaternion.setFromUnitVectors(axis, direction.set(Math.sin(angle), 0.35, Math.cos(angle)).normalize())
      matrix.compose(position, quaternion, scale)
      spears.current?.setMatrixAt(picketIndex, matrix)
      picketIndex += 1
      if (index % PILLAR_EVERY === 0) {
        position.y = 1.08
        quaternion.identity()
        matrix.compose(position, quaternion, scale)
        pillars.current?.setMatrixAt(pillarIndex++, matrix)
      }
    }
    if (pickets.current) { pickets.current.count = picketIndex; pickets.current.instanceMatrix.needsUpdate = true }
    if (spears.current) { spears.current.count = picketIndex; spears.current.instanceMatrix.needsUpdate = true }
    if (pillars.current) { pillars.current.count = pillarIndex; pillars.current.instanceMatrix.needsUpdate = true }
  }, [])

  return <group>
    <mesh geometry={lowerRail} material={material} castShadow receiveShadow />
    <mesh geometry={upperRail} material={material} castShadow receiveShadow />
    <instancedMesh ref={pickets} args={[picketGeometry, material, PICKET_COUNT]} castShadow receiveShadow />
    <instancedMesh ref={spears} args={[spearGeometry, material, PICKET_COUNT]} castShadow />
    <instancedMesh ref={pillars} args={[pillarGeometry, material, PICKET_COUNT / PILLAR_EVERY]} castShadow receiveShadow />
  </group>
}
