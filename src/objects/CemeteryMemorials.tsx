import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { batchStaticMeshes } from '../utils/batchStaticMeshes'
import { groundHeight } from './Ground'

// Small family plots occupy the sides; the entry and central encounter stay clear.
export const memorialPlots = [
  { x: -16, z: -30, yaw: 0.3 }, { x: 18, z: -43, yaw: -0.45 },
  { x: -18, z: -57, yaw: 0.65 }, { x: 17, z: -74, yaw: -0.22 },
]
export const memorialObstacles = memorialPlots.map(({ x, z }) => ({ x, z, radius: 2.5 }))

function makePlot(index: number) {
  const root = new THREE.Group()
  const stone = new THREE.MeshStandardMaterial({ color: '#555e60', roughness: 0.98 })
  const iron = new THREE.MeshStandardMaterial({ color: '#302e2b', metalness: 0.65, roughness: 0.8 })
  const wood = new THREE.MeshStandardMaterial({ color: '#39312b', roughness: 1 })
  const earth = new THREE.MeshStandardMaterial({ color: '#272b26', roughness: 1 })
  const leaf = new THREE.MeshStandardMaterial({ color: '#53513a', roughness: 1 })
  const wax = new THREE.MeshStandardMaterial({ color: '#c0b499', roughness: 0.9 })
  const fire = new THREE.MeshBasicMaterial({ color: '#ffc273', toneMapped: false })
  const materials = [stone, iron, wood, earth, leaf, wax, fire]
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, p: number[], rotation = 0) => {
    const m = new THREE.Mesh(geometry, material); m.position.set(p[0], p[1], p[2]); m.rotation.z = rotation
    m.castShadow = material !== fire; m.receiveShadow = material !== fire; root.add(m); return m
  }
  const box = (size: number[], material: THREE.Material, p: number[], rotation = 0) => add(new THREE.BoxGeometry(size[0], size[1], size[2]), material, p, rotation)
  // Chipped arched stones, including a collapsed marker and low burial mounds.
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * 1.55, z = Math.sin(index * 7 + i * 3) * 0.65
    const height = 1.2 + ((index + i) % 3) * 0.22
    const shape = new THREE.Shape()
    shape.moveTo(-0.4, 0); shape.lineTo(-0.42, height - 0.28)
    shape.quadraticCurveTo(-0.32, height + 0.15, 0, height + 0.15)
    shape.lineTo(0.09, height - 0.04); shape.lineTo(0.18, height + 0.11)
    shape.quadraticCurveTo(0.43, height, 0.4, height - 0.25); shape.lineTo(0.4, 0); shape.closePath()
    const marker = add(new THREE.ExtrudeGeometry(shape, { depth: 0.16, bevelEnabled: true, bevelSegments: 1, bevelSize: 0.025, bevelThickness: 0.025, curveSegments: 6 }), stone, [x, 0.06, z], (i - 1) * 0.1)
    if (i === 2 && index % 2 === 0) marker.rotation.x = -1.15
    box([0.98, 0.13, 0.5], stone, [x, 0.03, z])
    const mound = add(new THREE.SphereGeometry(1, 16, 8), earth, [x, -0.04, z + 1.05])
    mound.scale.set(0.55, 0.19, 1.05)
    // Cross inset on each upright marker.
    if (marker.rotation.x === 0) {
      box([0.045, 0.4, 0.014], iron, [x, height * 0.7, z + 0.19])
      box([0.24, 0.045, 0.014], iron, [x, height * 0.77, z + 0.2])
    }
  }
  // A leaning timber cross, rusted memorial lantern, and a dried wreath.
  box([0.12, 2.25, 0.13], wood, [-2.1, 1.02, -0.55], -0.13)
  box([0.88, 0.13, 0.15], wood, [-1.99, 1.63, -0.55], -0.13)
  const lanternX = 2.05, lanternZ = 0.45
  box([0.055, 2, 0.055], iron, [lanternX, 0.95, lanternZ])
  box([0.48, 0.045, 0.045], iron, [lanternX - 0.21, 1.93, lanternZ])
  const lx = lanternX - 0.4
  box([0.3, 0.055, 0.3], iron, [lx, 1.37, lanternZ])
  const roof = add(new THREE.ConeGeometry(0.25, 0.19, 4), iron, [lx, 1.85, lanternZ]); roof.rotation.y = Math.PI / 4
  for (const dx of [-0.13, 0.13]) for (const dz of [-0.13, 0.13]) box([0.022, 0.4, 0.022], iron, [lx + dx, 1.59, lanternZ + dz])
  add(new THREE.CylinderGeometry(0.055, 0.06, 0.2, 8), wax, [lx, 1.5, lanternZ])
  const flame = add(new THREE.SphereGeometry(0.04, 8, 6), fire, [lx, 1.65, lanternZ]); flame.scale.y = 1.8
  const wreath = add(new THREE.TorusGeometry(0.29, 0.035, 5, 24), wood, [-0.1, 0.5, 0.3]); wreath.rotation.x = -0.18
  for (let i = 0; i < 14; i++) {
    const angle = i / 14 * Math.PI * 2
    const twig = add(new THREE.OctahedronGeometry(0.095), leaf, [-0.1 + Math.cos(angle) * 0.3, 0.5 + Math.sin(angle) * 0.3, 0.32], angle)
    twig.scale.set(0.5, 1.3, 0.3)
  }
  // Abandoned shovel and loose coffin boards tell a story without filling the walking route.
  const handle = add(new THREE.CylinderGeometry(0.025, 0.03, 1.2, 6), wood, [1.15, 0.65, 1.3], -0.3)
  const blade = box([0.25, 0.33, 0.045], iron, [1.32, 0.12, 1.3], -0.3)
  handle.rotation.x = blade.rotation.x = -0.15
  if (index % 2 === 0) for (let i = 0; i < 3; i++) {
    const board = box([0.16, 0.055, 1.35], wood, [-1.2 + i * 0.15, 0.12 + i * 0.03, 1.25])
    board.rotation.y = i * 0.25 - 0.3
  }
  // Small offerings: melted votives, fallen flowers, and weathered memorial urns.
  for (let i = 0; i < 3; i++) {
    const cx = -1.8 + i * 0.22, cz = 1.65 + Math.sin(i * 2) * 0.12
    const h = 0.12 + i * 0.07
    add(new THREE.CylinderGeometry(0.06, 0.075, h, 10), wax, [cx, h / 2 + 0.06, cz])
    const tip = add(new THREE.SphereGeometry(0.025, 8, 6), fire, [cx, h + 0.09, cz]); tip.scale.y = 1.7
    const stem = box([0.016, 0.016, 0.6], leaf, [0.5 + i * 0.09, 0.12, 1.7]); stem.rotation.y = i * 0.24
    for (let petal = 0; petal < 5; petal++) {
      const angle = petal / 5 * Math.PI * 2
      const flower = add(new THREE.SphereGeometry(0.06, 8, 6), leaf, [0.5 + i * 0.09 + Math.cos(angle) * 0.04, 0.14, 1.98 + Math.sin(angle) * 0.04])
      flower.scale.y = 0.3
    }
  }
  const urn = add(new THREE.LatheGeometry([new THREE.Vector2(0.16, 0), new THREE.Vector2(0.12, 0.12), new THREE.Vector2(0.26, 0.32), new THREE.Vector2(0.29, 0.46), new THREE.Vector2(0.23, 0.49)], 16), stone, [2.0, 0.06, -0.9])
  urn.rotation.z = index % 2 ? 0.12 : -0.08
  add(new THREE.CylinderGeometry(0.22, 0.22, 0.03, 16), earth, [2.0, 0.53, -0.9])
  batchStaticMeshes(root)
  return { root, materials }
}

function MemorialPlot({ index }: { index: number }) {
  const { root, materials } = useMemo(() => makePlot(index), [index])
  useEffect(() => () => {
    root.traverse(node => { if (node instanceof THREE.Mesh) node.geometry.dispose() })
    materials.forEach(material => material.dispose())
  }, [root, materials])
  const { x, z, yaw } = memorialPlots[index]
  return <group position={[x, groundHeight(x, z), z]} rotation={[0, yaw, 0]}><primitive object={root} /></group>
}

export function CemeteryMemorials() {
  return <group>{memorialPlots.map((_, i) => <MemorialPlot key={i} index={i} />)}</group>
}
