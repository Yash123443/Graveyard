import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { groundHeight } from './Ground'
import { batchStaticMeshes } from '../utils/batchStaticMeshes'
import { seq } from '../animations/sequence'

export const witchCorners = [{ x: -14.8, z: -20.6 }, { x: 17.8, z: -25.4 }, { x: -15.8, z: -66.3 }]
export const witchObstacles = witchCorners.map(({ x, z }) => ({ x, z, radius: 0.85 }))

function WitchCorner({ index }: { index: number }) {
  const { root, bubbles, materials, geometries } = useMemo(() => {
    const root = new THREE.Group()
    const iron = new THREE.MeshStandardMaterial({ color: '#292d2d', metalness: 0.65, roughness: 0.78 })
    const wood = new THREE.MeshStandardMaterial({ color: '#6b5840', roughness: 1 })
    const straw = new THREE.MeshStandardMaterial({ color: '#9b8453', roughness: 1 })
    const purple = new THREE.MeshStandardMaterial({ color: '#322537', roughness: 0.96 })
    const bone = new THREE.MeshStandardMaterial({ color: '#b1a58c', emissive: '#333e49', emissiveIntensity: 0.15, roughness: 1 })
    const brew = new THREE.MeshBasicMaterial({ color: index % 2 ? '#b494e8' : '#80bfa2', toneMapped: false })
    const glass = new THREE.MeshStandardMaterial({ color: '#3b6d5e', metalness: 0.12, roughness: 0.24, emissive: '#224737', emissiveIntensity: 0.28 })
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, p: number[]) => {
      const mesh = new THREE.Mesh(geometry, material); mesh.position.set(p[0], p[1], p[2]); root.add(mesh); return mesh
    }
    const pot = new THREE.LatheGeometry([new THREE.Vector2(0.02, 0.12), new THREE.Vector2(0.3, 0.13), new THREE.Vector2(0.48, 0.31), new THREE.Vector2(0.52, 0.56), new THREE.Vector2(0.42, 0.78), new THREE.Vector2(0.43, 0.83), new THREE.Vector2(0.38, 0.83), new THREE.Vector2(0.37, 0.74), new THREE.Vector2(0.4, 0.56)], 32)
    add(pot, iron, [0, 0, 0])
    add(new THREE.TorusGeometry(0.41, 0.045, 8, 32), iron, [0, 0.81, 0]).rotation.x = Math.PI / 2
    add(new THREE.CylinderGeometry(0.37, 0.37, 0.018, 32), brew, [0, 0.745, 0])
    for (const side of [-1, 1]) {
      const handle = add(new THREE.TorusGeometry(0.14, 0.025, 6, 20), iron, [side * 0.48, 0.6, 0]); handle.rotation.y = Math.PI / 2
    }
    for (let i = 0; i < 3; i++) {
      const angle = i / 3 * Math.PI * 2
      add(new THREE.CylinderGeometry(0.045, 0.065, 0.22, 6), iron, [Math.cos(angle) * 0.3, 0.1, Math.sin(angle) * 0.3])
    }
    // A bent hat resting on a weathered crate.
    add(new THREE.BoxGeometry(0.65, 0.38, 0.55), wood, [1.05, 0.19, -0.15])
    for (let i = 0; i < 4; i++) add(new THREE.BoxGeometry(0.67, 0.016, 0.02), iron, [1.05, 0.08 + i * 0.08, 0.135])
    add(new THREE.CylinderGeometry(0.46, 0.49, 0.045, 32), purple, [1.05, 0.42, -0.15])
    const hat = new THREE.ConeGeometry(0.27, 0.72, 28, 12)
    const hp = hat.attributes.position
    for (let i = 0; i < hp.count; i++) {
      const t = (hp.getY(i) + 0.36) / 0.72
      hp.setX(i, hp.getX(i) + t * t * 0.24)
    }
    hat.computeVertexNormals(); add(hat, purple, [1.05, 0.8, -0.15])
    const band = add(new THREE.TorusGeometry(0.245, 0.035, 6, 28), wood, [1.05, 0.51, -0.15]); band.rotation.x = Math.PI / 2
    add(new THREE.BoxGeometry(0.1, 0.08, 0.025), iron, [1.05, 0.51, 0.11])
    // Broom: irregular split reeds with a bound timber handle.
    const handle = add(new THREE.CylinderGeometry(0.022, 0.033, 1.7, 7), wood, [-0.87, 0.98, -0.25]); handle.rotation.z = -0.24
    for (let i = 0; i < 18; i++) {
      const angle = i * 2.4, x = -1.06 + Math.cos(angle) * 0.12, z = -0.25 + Math.sin(angle) * 0.1
      const reed = add(new THREE.CylinderGeometry(0.008, 0.014, 0.55 + (i % 3) * 0.035, 4), straw, [x, 0.3, z]); reed.rotation.z = -0.1 + Math.cos(angle) * 0.2
    }
    add(new THREE.TorusGeometry(0.08, 0.014, 5, 16), iron, [-1.02, 0.53, -0.25]).rotation.x = Math.PI / 2
    for (let i = 0; i < 3; i++) {
      const x = 0.7 + i * 0.2, z = 0.5 + (i % 2) * 0.17
      add(new THREE.SphereGeometry(0.095, 12, 8), glass, [x, 0.13, z]).scale.y = 1.2
      add(new THREE.CylinderGeometry(0.035, 0.05, 0.15, 8), glass, [x, 0.26, z])
      add(new THREE.CylinderGeometry(0.035, 0.035, 0.045, 7), wood, [x, 0.35, z])
    }
    const palm = add(new THREE.SphereGeometry(0.12, 12, 8), bone, [-0.6, 0.15, 0.8]); palm.scale.set(0.9, 1.2, 0.45)
    for (let i = 0; i < 5; i++) {
      const x = -0.71 + i * 0.05
      const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(x, 0.22, 0.8), new THREE.Vector3(x, 0.4 - Math.abs(i - 2) * 0.04, 0.79), new THREE.Vector3(x + 0.01, 0.42 - Math.abs(i - 2) * 0.04, 0.88)])
      add(new THREE.TubeGeometry(curve, 10, 0.017, 5, false), bone, [0, 0, 0])
    }
    batchStaticMeshes(root)
    const bubbleGeometry = new THREE.SphereGeometry(0.045, 8, 6)
    const bubbles = new THREE.InstancedMesh(bubbleGeometry, brew, 12); root.add(bubbles)
    return { root, bubbles, materials: [iron, wood, straw, purple, bone, brew, glass], geometries: [bubbleGeometry] }
  }, [index])
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const { x, z } = witchCorners[index]
  useFrame(({ camera, clock }) => {
    root.visible = seq.reveal.trees > 0.4 && Math.hypot(camera.position.x - x, camera.position.z - z) < 35
    if (!root.visible) return
    for (let i = 0; i < 12; i++) {
      const life = (clock.elapsedTime * 0.3 + i / 12) % 1
      dummy.position.set(Math.cos(i * 2.4) * 0.24, 0.76 + life * 0.55, Math.sin(i * 2.4) * 0.24)
      dummy.scale.setScalar(Math.sin(life * Math.PI) * 0.8); dummy.updateMatrix(); bubbles.setMatrixAt(i, dummy.matrix)
    }
    bubbles.instanceMatrix.needsUpdate = true
  })
  useEffect(() => () => {
    const owned = new Set(geometries)
    root.traverse(node => { if (node instanceof THREE.Mesh) owned.add(node.geometry) })
    owned.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose())
  }, [root, materials, geometries])
  return <group position={[x, groundHeight(x, z), z]} rotation={[0, index * 0.65, 0]}><primitive object={root} /></group>
}
export function WitchCorners() { return <group>{witchCorners.map((_, i) => <WitchCorner key={i} index={i} />)}</group> }
