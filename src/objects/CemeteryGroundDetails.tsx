import { useMemo } from 'react'
import * as THREE from 'three'
import { groundHeight } from './Ground'

const gatheringPlaces: [number, number][] = [
  [-8.5, -24], [10, -35], [-12.5, -48], [13.5, -58], [-9, -68], [9, -73],
  [-19, -18], [22, -21], [-31, -40], [32, -45], [-20, -63], [23, -68],
]

function noise(index: number, salt: number) {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453
  return value - Math.floor(value)
}

/** Pebble clusters and old fallen limbs break up the soil without adding flat scenery. */
export function CemeteryGroundDetails() {
  const { branches } = useMemo(() => {
    const branchGeometry = new THREE.CylinderGeometry(0.024, 0.055, 1.35, 6)
    const branchMaterial = new THREE.MeshStandardMaterial({ color: '#29241d', roughness: 1 })
    const branchMesh = new THREE.InstancedMesh(branchGeometry, branchMaterial, 38)
    const matrix = new THREE.Matrix4()
    const p = new THREE.Vector3()
    const s = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const direction = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    for (let index = 0; index < 38; index += 1) {
      const anchor = gatheringPlaces[(index * 5 + 2) % gatheringPlaces.length]
      const angle = noise(index, 12) * Math.PI * 2
      const radius = 2.8 + noise(index, 13) * 5.5
      const length = 0.65 + noise(index, 14) * 1.45
      const x = anchor[0] + Math.cos(angle) * radius
      const z = anchor[1] + Math.sin(angle) * radius
      p.set(x, groundHeight(x, z) + 0.045, z)
      direction.set(Math.cos(angle + 0.8), 0, Math.sin(angle + 0.8)).normalize()
      q.setFromUnitVectors(up, direction)
      s.set(0.75 + noise(index, 15) * 0.8, length / 1.35, 0.8 + noise(index, 16) * 0.5)
      matrix.compose(p, q, s)
      branchMesh.setMatrixAt(index, matrix)
    }
    branchMesh.instanceMatrix.needsUpdate = true
    branchMesh.castShadow = true
    branchMesh.receiveShadow = true
    return { branches: branchMesh }
  }, [])

  return <group><primitive object={branches} /></group>
}
