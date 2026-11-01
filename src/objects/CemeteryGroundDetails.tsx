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
  const { rocks, branches } = useMemo(() => {
    const rockGeometry = new THREE.DodecahedronGeometry(1, 0)
    const rockMaterial = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 })
    const rockMesh = new THREE.InstancedMesh(rockGeometry, rockMaterial, 150)
    const branchGeometry = new THREE.CylinderGeometry(0.024, 0.055, 1.35, 6)
    const branchMaterial = new THREE.MeshStandardMaterial({ color: '#29241d', roughness: 1 })
    const branchMesh = new THREE.InstancedMesh(branchGeometry, branchMaterial, 38)
    const matrix = new THREE.Matrix4()
    const p = new THREE.Vector3()
    const s = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const direction = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    const palette = ['#55483a', '#3e3931', '#665444', '#4b4a42']

    for (let index = 0; index < 150; index += 1) {
      const anchor = gatheringPlaces[index % gatheringPlaces.length]
      const angle = noise(index, 1) * Math.PI * 2
      const radius = 1.45 + noise(index, 2) * 5.4
      const x = anchor[0] + Math.cos(angle) * radius
      const z = anchor[1] + Math.sin(angle) * radius
      const size = 0.07 + noise(index, 3) * 0.2
      p.set(x, groundHeight(x, z) + size * 0.26, z)
      q.setFromEuler(new THREE.Euler(noise(index, 4) * 0.7, noise(index, 5) * Math.PI, noise(index, 6) * 0.4))
      s.set(size * (0.8 + noise(index, 7)), size * (0.45 + noise(index, 8) * 0.5), size * (0.7 + noise(index, 9) * 0.6))
      matrix.compose(p, q, s)
      rockMesh.setMatrixAt(index, matrix)
      rockMesh.setColorAt(index, new THREE.Color(palette[index % palette.length]))
    }
    rockMesh.instanceMatrix.needsUpdate = true
    if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true

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
    rockMesh.castShadow = true
    rockMesh.receiveShadow = true
    branchMesh.castShadow = true
    branchMesh.receiveShadow = true
    return { rocks: rockMesh, branches: branchMesh }
  }, [])

  return <group><primitive object={rocks} /><primitive object={branches} /></group>
}
