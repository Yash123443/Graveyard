import { useMemo } from 'react'
import * as THREE from 'three'
import { groundHeight } from './Ground'

const grassPatches = Array.from({ length: 132 }, (_, index) => ({
  x: Math.sin(index * 41.17) * 25 + Math.sin(index * 0.7) * 5,
  z: -7 - ((index * 17.31) % 76),
  scale: 0.56 + (index % 4) * 0.13,
  rotation: (index * 1.17) % Math.PI,
}))

const BLADES_PER_PATCH = 6
const bladeColors = ['#675d45', '#4f503f', '#786949', '#5c5645', '#777354']

function noise(index: number, salt: number) {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453
  return value - Math.floor(value)
}

/** Low tufts of individual dry grass blades, spread in irregular ground patches. */
export function DeadGrass() {
  const batch = useMemo(() => {
    const geometry = new THREE.ConeGeometry(0.024, 1, 5, 1)
    const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, vertexColors: true })
    const mesh = new THREE.InstancedMesh(geometry, material, grassPatches.length * BLADES_PER_PATCH)
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const rotation = new THREE.Euler()
    const quaternion = new THREE.Quaternion()
    let instance = 0

    grassPatches.forEach((patch, patchIndex) => {
      const baseY = groundHeight(patch.x, patch.z)
      for (let blade = 0; blade < BLADES_PER_PATCH; blade += 1) {
        const id = patchIndex * BLADES_PER_PATCH + blade
        const angle = (blade / BLADES_PER_PATCH) * Math.PI * 2 + patch.rotation + noise(id, 1) * 0.5
        const spread = 0.035 + noise(id, 2) * 0.22
        const height = (0.42 + noise(id, 3) * 0.36) * patch.scale
        const lean = 0.08 + noise(id, 4) * 0.3
        position.set(
          patch.x + Math.cos(angle) * spread,
          baseY + 0.025 + height * 0.5,
          patch.z + Math.sin(angle) * spread,
        )
        rotation.set(Math.cos(angle) * lean, angle, Math.sin(angle) * lean)
        quaternion.setFromEuler(rotation)
        scale.set(0.8 + noise(id, 5) * 0.55, height, 0.8 + noise(id, 6) * 0.55)
        matrix.compose(position, quaternion, scale)
        mesh.setMatrixAt(instance, matrix)
        mesh.setColorAt(instance, new THREE.Color(bladeColors[id % bladeColors.length]))
        instance += 1
      }
    })

    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }, [])

  return <primitive object={batch} />
}
