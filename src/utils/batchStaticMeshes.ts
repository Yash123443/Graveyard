import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/** Bake only static descendants into material batches; animated subtrees stay independent. */
export function batchStaticMeshes(root: THREE.Group, exclude = new Set<THREE.Object3D>()) {
  root.updateWorldMatrix(true, true)
  const inverse = root.matrixWorld.clone().invert()
  const batches = new Map<THREE.Material, THREE.Mesh[]>()
  const visit = (node: THREE.Object3D) => {
    if (exclude.has(node)) return
    if (node instanceof THREE.Mesh && !Array.isArray(node.material)) {
      const list = batches.get(node.material) ?? []
      list.push(node); batches.set(node.material, list)
    }
    node.children.forEach(visit)
  }
  root.children.forEach(visit)
  for (const [material, meshes] of batches) {
    if (meshes.length < 2) continue
    const parts = meshes.map(mesh => {
      const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()
      // All batches use position/normal only: retain UVs for textured materials.
      for (const name of Object.keys(geometry.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geometry.deleteAttribute(name)
      if (!geometry.attributes.uv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 2), 2))
      geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld))
      return geometry
    })
    const merged = mergeGeometries(parts, false)
    parts.forEach(part => part.dispose())
    if (!merged) continue
    const batch = new THREE.Mesh(merged, material)
    batch.castShadow = meshes.some(mesh => mesh.castShadow)
    batch.receiveShadow = meshes.some(mesh => mesh.receiveShadow)
    merged.computeBoundingSphere()
    const old = new Set(meshes.map(mesh => mesh.geometry))
    meshes.forEach(mesh => mesh.removeFromParent())
    old.forEach(geometry => geometry.dispose())
    root.add(batch)
  }
}
