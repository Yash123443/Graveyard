import { useMemo } from 'react'
import * as THREE from 'three'
import { groundHeight } from './Ground'

const clusters: [number, number][] = [
  [-19, -18], [22, -21], [-31, -40], [32, -45], [-20, -63], [23, -68], [-43, -6], [45, -12],
  [-8.5, -24], [10, -35], [-12.5, -48], [13.5, -58], [-9, -68], [9, -73],
  [-2, -30], [-1, -41], [1, -52], [2, -63],
]
const leafColors = ['#76502e', '#5c3d25', '#8a5c30', '#4b3b2b', '#6b492b']
const leaves = Array.from({ length: clusters.length * 24 }, (_, index) => {
  const cluster = clusters[Math.floor(index / 24)]
  const local = index % 24
  const angle = local * 2.399 + Math.floor(index / 18) * 0.73
  const radius = 0.9 + ((local * 7) % 11) * 0.33
  const x = cluster[0] + Math.cos(angle) * radius
  const z = cluster[1] + Math.sin(angle) * radius * 0.72
  return {
    x, z,
    y: groundHeight(x, z) + 0.035,
    rotation: (index * 1.87) % Math.PI,
    scale: 0.19 + (index % 5) * 0.045,
    color: leafColors[index % leafColors.length],
  }
})

function makeLeafGeometry() {
  const leaf = new THREE.Shape()
  leaf.moveTo(-0.68, 0)
  leaf.quadraticCurveTo(-0.32, -0.29, 0.05, -0.24)
  leaf.quadraticCurveTo(0.42, -0.16, 0.68, 0)
  leaf.quadraticCurveTo(0.34, 0.27, -0.04, 0.24)
  leaf.quadraticCurveTo(-0.42, 0.17, -0.68, 0)
  return new THREE.ShapeGeometry(leaf, 8)
}

export function LeafLitter() {
  const batch = useMemo(() => {
    const geometry = makeLeafGeometry()
    const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, side: THREE.DoubleSide })
    const mesh = new THREE.InstancedMesh(geometry, material, leaves.length)
    const matrix = new THREE.Matrix4()
    const p = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    const e = new THREE.Euler()
    leaves.forEach((leaf, index) => {
      p.set(leaf.x, leaf.y, leaf.z)
      e.set(-Math.PI / 2 + 0.12, 0.18, leaf.rotation)
      q.setFromEuler(e)
      s.setScalar(leaf.scale)
      matrix.compose(p, q, s)
      mesh.setMatrixAt(index, matrix)
      mesh.setColorAt(index, new THREE.Color(leaf.color))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    return mesh
  }, [])
  return <primitive object={batch} />
}
