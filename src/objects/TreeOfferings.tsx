import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { batchStaticMeshes } from '../utils/batchStaticMeshes'
import { seq } from '../animations/sequence'

/** Rusted lantern and small bone mobile, suspended beside the trunk. No additional lights. */
export function TreeOfferings({ position, index }: { position: [number, number, number]; index: number }) {
  const { group, glow, materials } = useMemo(() => {
    const group = new THREE.Group()
    const iron = new THREE.MeshStandardMaterial({ color: '#373632', roughness: 0.87, metalness: 0.5 })
    const bone = new THREE.MeshStandardMaterial({ color: '#9e9680', roughness: 0.95 })
    const rope = new THREE.MeshStandardMaterial({ color: '#665949', roughness: 1 })
    const glow = new THREE.MeshBasicMaterial({ color: '#ffb35e', toneMapped: false, transparent: true, opacity: 0 })
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z = 0) => {
      const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, z); group.add(mesh); return mesh
    }
    // A cord wraps the branch and supports the lantern by its metal loop.
    add(new THREE.CylinderGeometry(0.015, 0.015, 1.25, 5), rope, 0, -0.62)
    add(new THREE.TorusGeometry(0.09, 0.014, 5, 16), iron, 0, -1.31)
    add(new THREE.ConeGeometry(0.28, 0.22, 4), iron, 0, -1.48).rotation.y = Math.PI / 4
    add(new THREE.BoxGeometry(0.34, 0.05, 0.34), iron, 0, -2.02)
    for (const x of [-0.15, 0.15]) for (const z of [-0.15, 0.15]) add(new THREE.CylinderGeometry(0.015, 0.015, 0.46, 5), iron, x, -1.77, z)
    add(new THREE.CylinderGeometry(0.055, 0.06, 0.17, 8), bone, 0, -1.92)
    add(new THREE.SphereGeometry(0.045, 8, 6), glow, 0, -1.79).scale.y = 1.7
    // Crooked charm branches and dangling bone pairs vary by tree.
    const bar = add(new THREE.CylinderGeometry(0.02, 0.025, 0.85, 5), rope, 0.7, -0.35)
    bar.rotation.z = 1.35
    for (let i = 0; i < 3; i++) {
      const x = 0.4 + i * 0.27, length = 0.45 + ((i + index) % 3) * 0.17
      add(new THREE.CylinderGeometry(0.009, 0.009, length, 4), rope, x, -0.4 - length / 2)
      const charm = add(new THREE.CylinderGeometry(0.025, 0.035, 0.26, 6), bone, x, -0.54 - length)
      charm.rotation.z = (i - 1) * 0.35
      for (const dy of [-0.13, 0.13]) add(new THREE.SphereGeometry(0.038, 6, 4), bone, x, -0.54 - length + dy)
    }
    batchStaticMeshes(group)
    return { group, glow, materials: [iron, bone, rope, glow] }
  }, [index])
  useFrame(({ clock, camera }) => {
    group.visible = seq.reveal.trees > 0.3 && Math.hypot(camera.position.x - position[0], camera.position.z - position[2]) < 48
    if (!group.visible) return
    group.rotation.z = Math.sin(clock.elapsedTime * 0.6 + index * 1.8) * 0.035
    glow.opacity = seq.reveal.light * (0.8 + Math.sin(clock.elapsedTime * 7 + index) * 0.1)
  })
  useEffect(() => () => {
    group.traverse(node => { if (node instanceof THREE.Mesh) node.geometry.dispose() })
    materials.forEach(material => material.dispose())
  }, [group, materials])
  return <group position={[position[0] + (index % 2 ? -2 : 2), position[1] + 4.2, position[2] + 1.25]}>
    <primitive object={group} scale={1.35} />
  </group>
}
