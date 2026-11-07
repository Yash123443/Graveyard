import { useGLTF } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq } from '../animations/sequence'

// The GLB is ~1 unit tall and centred on its origin, so `scale` is the tree's height in world units.
const MODEL_HALF_HEIGHT = 0.49
const trees = [
  { position: [-19, 0, -18] as [number, number, number], rotation: 0.2, scale: 20 },
  { position: [22, 0, -21] as [number, number, number], rotation: -0.55, scale: 21 },
  { position: [-31, 0, -40] as [number, number, number], rotation: 0.65, scale: 23 },
  { position: [32, 0, -45] as [number, number, number], rotation: -0.32, scale: 24 },
  { position: [-20, 0, -63] as [number, number, number], rotation: 1.1, scale: 22 },
  { position: [23, 0, -68] as [number, number, number], rotation: 2.3, scale: 25 },
  { position: [-43, 0, -6] as [number, number, number], rotation: 0.9, scale: 18 },
  { position: [45, 0, -12] as [number, number, number], rotation: -1.4, scale: 19 },
]
export const deadTreeCollision = trees.map((tree) => ({ x: tree.position[0], z: tree.position[2], radius: tree.scale * 0.13 }))

interface Tinted {
  mesh: THREE.InstancedMesh
}

/** Dead trees: one GLB, many placements. They surface from the dark by scaling surface colour. */
export function DeadTreeCluster() {
  const { scene } = useGLTF('/models/dead-tree-background.glb')
  const tint = useMemo(() => new THREE.Color(), [])
  const lastReveal = useRef(-1)

  const { instanceGroup, tinted } = useMemo(() => {
    const instanceGroup = new THREE.Group()
    const list: Tinted[] = []
    scene.updateMatrixWorld(true)
    scene.traverse((child) => {
      const source = child as THREE.Mesh
      if (!source.isMesh) return
      const sourceMaterials = Array.isArray(source.material) ? source.material : [source.material]
      const materials = sourceMaterials.map((sourceMaterial) => {
        const mat = sourceMaterial.clone() as THREE.MeshStandardMaterial
        mat.roughness = 1
        mat.metalness = 0
        mat.color.multiplyScalar(0.62)
        return mat
      })
      const material = Array.isArray(source.material) ? materials : materials[0]
      const instanced = new THREE.InstancedMesh(source.geometry, material, trees.length)
      instanced.castShadow = true
      instanced.receiveShadow = true
      const p = new THREE.Vector3()
      const q = new THREE.Quaternion()
      const s = new THREE.Vector3()
      const e = new THREE.Euler()
      const matrix = new THREE.Matrix4()
      trees.forEach((tree, index) => {
        const y = tree.scale * MODEL_HALF_HEIGHT - 0.15
        p.set(tree.position[0], y, tree.position[2])
        e.set(0, tree.rotation, 0)
        q.setFromEuler(e)
        s.setScalar(tree.scale)
        matrix.compose(p, q, s).multiply(source.matrixWorld)
        instanced.setMatrixAt(index, matrix)
        instanced.setColorAt(index, new THREE.Color(0))
      })
      instanced.instanceMatrix.needsUpdate = true
      if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true
      instanceGroup.add(instanced)
      list.push({ mesh: instanced })
    })
    return { instanceGroup, tinted: list }
  }, [scene])

  useEffect(() => () => tinted.forEach(({ mesh }) => {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach((material) => material.dispose())
  }), [tinted])

  useFrame(() => {
    const k = seq.reveal.trees
    if (k === lastReveal.current) return
    lastReveal.current = k
    tint.setRGB(k, k, k)
    tinted.forEach(({ mesh }) => {
      for (let i = 0; i < mesh.count; i += 1) mesh.setColorAt(i, tint)
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    })
  })

  return <primitive object={instanceGroup} />
}

useGLTF.preload('/models/dead-tree-background.glb')
