import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq } from '../animations/sequence'
import { GATE_Z } from './CemeteryGate'
import { groundHeight } from './Ground'

const pumpkinSpots: [number, number, number][] = [
  [-7.8, -7.2, 0.2], [7.7, -7.4, -0.35], [-10.5, -26, 0.8], [8.8, -34, -0.4],
  [-4.8, -49, 0.25], [5.6, -57, -0.6], [-9.1, -69, 0.5], [10.2, -72, -0.2],
  [2.8, -30, 0.6], [-3.2, -61, -0.45],
]

function Pumpkin({ scale = 1 }: { scale?: number }) {
  const orange = useMemo(() => new THREE.MeshStandardMaterial({ color: '#a74718', roughness: 0.92, metalness: 0.02 }), [])
  const stem = useMemo(() => new THREE.MeshStandardMaterial({ color: '#3d2c1f', roughness: 1 }), [])
  const glow = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffb14e', transparent: true, opacity: 0.88, toneMapped: false }), [])
  return (
    <group scale={scale}>
      <mesh material={orange} castShadow receiveShadow scale={[1, 0.83, 0.88]}><sphereGeometry args={[0.62, 20, 14]} /></mesh>
      {[-0.28, -0.09, 0.09, 0.28].map((x) => <mesh key={x} material={orange} position={[x, 0.02, 0]} scale={[0.76, 0.84, 0.93]} castShadow><sphereGeometry args={[0.52, 16, 12]} /></mesh>)}
      <mesh material={stem} position={[0, 0.62, -0.02]} rotation={[0.12, 0.15, -0.08]} castShadow><cylinderGeometry args={[0.075, 0.11, 0.32, 8]} /></mesh>
      <group position={[0, 0.03, 0.49]}>
        <mesh material={glow} position={[-0.18, 0.07, 0]} rotation={[0, 0, 0.12]}><coneGeometry args={[0.1, 0.14, 3]} /></mesh>
        <mesh material={glow} position={[0.18, 0.07, 0]} rotation={[0, 0, -0.12]}><coneGeometry args={[0.1, 0.14, 3]} /></mesh>
        <mesh material={glow} position={[0, -0.13, 0]} scale={[1.15, 0.55, 1]}><coneGeometry args={[0.17, 0.18, 3]} /></mesh>
      </group>
    </group>
  )
}

function CandleCluster({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  const wax = useMemo(() => new THREE.MeshStandardMaterial({ color: '#d6c7ae', roughness: 0.96 }), [])
  const flame = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffb45a', toneMapped: false }), [])
  return <group position={position} scale={scale}>
    {[-0.18, 0, 0.17].map((x, i) => <group key={x} position={[x, i % 2 ? 0.22 : 0.12, 0]}>
      <mesh material={wax} castShadow><cylinderGeometry args={[0.055, 0.07, i % 2 ? 0.46 : 0.28, 10]} /></mesh>
      <mesh material={flame} position={[0, i % 2 ? 0.27 : 0.18, 0]}><sphereGeometry args={[0.055, 8, 6]} /></mesh>
    </group>)}
    <pointLight color="#ff8f3f" intensity={0.32} distance={2.8} position={[0, 0.5, 0.18]} />
  </group>
}

function Skull({ size = 1 }: { size?: number }) {
  const bone = useMemo(() => new THREE.MeshStandardMaterial({ color: '#aaa08c', roughness: 0.98 }), [])
  const dark = useMemo(() => new THREE.MeshBasicMaterial({ color: '#171315' }), [])
  return <group scale={size}>
    <mesh material={bone} castShadow><sphereGeometry args={[0.34, 14, 10]} /></mesh>
    <mesh material={bone} position={[0, -0.28, 0]}><boxGeometry args={[0.28, 0.26, 0.2]} /></mesh>
    {[-0.12, 0.12].map((x) => <mesh key={x} material={dark} position={[x, 0.02, 0.29]}><sphereGeometry args={[0.055, 8, 6]} /></mesh>)}
    <mesh material={dark} position={[0, -0.1, 0.3]} rotation={[0, 0, Math.PI / 2]}><coneGeometry args={[0.055, 0.16, 3]} /></mesh>
  </group>
}

function HangingTreeCharm({ position, rotation = 0 }: { position: [number, number, number]; rotation?: number }) {
  const rope = useMemo(() => new THREE.MeshStandardMaterial({ color: '#261d1a', roughness: 1 }), [])
  return <group position={position} rotation={[0, rotation, 0]}>
    <mesh material={rope} position={[0, -0.75, 0]}><cylinderGeometry args={[0.018, 0.018, 1.5, 6]} /></mesh>
    <mesh material={rope} position={[0, 0, 0]} rotation={[0, 0, Math.PI / 2]}><torusGeometry args={[0.22, 0.018, 6, 18, Math.PI * 1.65]} /></mesh>
    <group position={[0, -1.08, 0]}><Skull size={0.72} /></group>
  </group>
}

function Raven({ position, rotation = 0 }: { position: [number, number, number]; rotation?: number }) {
  const feather = useMemo(() => new THREE.MeshStandardMaterial({ color: '#090b10', roughness: 0.82, metalness: 0.08 }), [])
  return <group position={position} rotation={[0, rotation, 0]}>
    <mesh material={feather} castShadow scale={[0.28, 0.16, 0.58]}><sphereGeometry args={[1, 10, 8]} /></mesh>
    <mesh material={feather} position={[0, 0.04, 0.56]} rotation={[0.2, 0, 0]}><coneGeometry args={[0.12, 0.42, 6]} /></mesh>
    {[-1, 1].map((side) => <mesh key={side} material={feather} position={[side * 0.28, 0.02, 0]} rotation={[0, side * 0.35, side * 0.25]}><coneGeometry args={[0.18, 0.72, 5]} /></mesh>)}
  </group>
}

function TreeWeb({ position, rotation = 0 }: { position: [number, number, number]; rotation?: number }) {
  const web = useMemo(() => new THREE.LineBasicMaterial({ color: '#c4cbd0', transparent: true, opacity: 0.42 }), [])
  const geometry = useMemo(() => {
    const points: number[] = []
    const spokes = 10
    for (let spoke = 0; spoke < spokes; spoke += 1) {
      const a = (spoke / spokes) * Math.PI * 2
      points.push(0, 0, 0, Math.cos(a) * 0.7, Math.sin(a) * 0.7, 0)
    }
    for (const radius of [0.2, 0.38, 0.56, 0.7]) {
      for (let i = 0; i < spokes; i += 1) {
        const a0 = (i / spokes) * Math.PI * 2
        const a1 = ((i + 1) / spokes) * Math.PI * 2
        points.push(Math.cos(a0) * radius, Math.sin(a0) * radius, 0, Math.cos(a1) * radius, Math.sin(a1) * radius, 0)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    return g
  }, [])
  return <group position={position} rotation={[0, rotation, 0]}><lineSegments geometry={geometry} material={web} /></group>
}

function Spider({ position, scale = 1, hanging = false }: { position: [number, number, number]; scale?: number; hanging?: boolean }) {
  const root = useRef<THREE.Group>(null)
  const legMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: '#111017', roughness: 0.78, metalness: 0.18 }), [])
  const bodyMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: '#08090e', roughness: 0.68, metalness: 0.22 }), [])
  const eyes = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ff4b38', toneMapped: false }), [])
  useFrame(({ clock }) => {
    if (!root.current) return
    root.current.rotation.z = Math.sin(clock.elapsedTime * 1.4 + position[0]) * 0.07
    root.current.rotation.y = Math.sin(clock.elapsedTime * 0.8 + position[2]) * 0.12
  })
  return <group ref={root} position={position} scale={scale}>
    {hanging && <mesh material={legMaterial} position={[0, 0.58, 0]}><cylinderGeometry args={[0.012, 0.012, 1.2, 6]} /></mesh>}
    <mesh material={bodyMaterial} scale={[1.35, 0.72, 1]} castShadow><sphereGeometry args={[0.16, 14, 10]} /></mesh>
    <mesh material={bodyMaterial} position={[0, 0.02, 0.18]} scale={[0.72, 0.64, 0.75]} castShadow><sphereGeometry args={[0.13, 14, 10]} /></mesh>
    {[-1, 1].flatMap((side) => [0, 1, 2, 3].map((i) => (
      <mesh key={`${side}-${i}`} material={legMaterial} position={[side * (0.1 + i * 0.025), -0.01, -0.01]} rotation={[0, side * (0.18 + i * 0.05), side * (0.5 + i * 0.12)]}>
        <cylinderGeometry args={[0.012, 0.018, 0.38 + i * 0.035, 6]} />
      </mesh>
    )))}
    <mesh material={eyes} position={[-0.045, 0.05, 0.285]}><sphereGeometry args={[0.018, 8, 6]} /></mesh>
    <mesh material={eyes} position={[0.045, 0.05, 0.285]}><sphereGeometry args={[0.018, 8, 6]} /></mesh>
  </group>
}

function HangingSpider({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  return <group position={position}><Spider position={[0, -0.7, 0]} scale={scale} hanging /></group>
}

const treeDecor: [number, number, number, number][] = [
  [-19, -18, 4.9, 0.2], [22, -21, 5.3, -0.4], [-31, -40, 5.8, 0.6],
  [32, -45, 5.4, -0.3], [-20, -63, 5.6, 0.5], [23, -68, 6.1, -0.7],
]

const groundSpiders: [number, number][] = [[-8.6, -23], [11.2, -39], [-7.5, -54], [8.2, -66]]

export function HalloweenProps() {
  return <group>
    {pumpkinSpots.map(([x, z, r], i) => {
      const scale = 0.68 + (i % 4) * 0.1
      return <group key={`pumpkin-${i}`} position={[x, groundHeight(x, z) + 0.5 * scale, z]} rotation={[0, r, 0]}><Pumpkin scale={scale} /></group>
    })}
    <CandleCluster position={[-6.4, groundHeight(-6.4, GATE_Z - 0.65) + 0.08, GATE_Z - 0.65]} scale={1.1} />
    <CandleCluster position={[6.5, groundHeight(6.5, GATE_Z - 0.7) + 0.08, GATE_Z - 0.7]} scale={0.92} />
    <group position={[2.4, groundHeight(2.4, -42) + 0.35, -42]} rotation={[0, -0.25, 0]}><Skull size={1} /></group>
    <group position={[-13, groundHeight(-13, -36) + 0.12, -36]}><Skull size={0.7} /></group>
    {groundSpiders.map(([x, z], i) => <Spider key={`ground-spider-${i}`} position={[x, groundHeight(x, z) + 0.16, z]} scale={0.9 + (i % 2) * 0.25} />)}
    {treeDecor.map(([x, z, y, r], i) => <group key={`tree-decor-${i}`}>
      <HangingTreeCharm position={[x + 0.35, groundHeight(x, z) + y, z + 0.4]} rotation={r} />
      <TreeWeb position={[x - 0.35, groundHeight(x, z) + y - 0.8, z + 0.25]} rotation={r + 0.3} />
      <HangingSpider position={[x - 0.2, groundHeight(x, z) + y - 0.25, z + 0.34]} scale={0.72 + (i % 3) * 0.13} />
      <Raven position={[x + 0.8, groundHeight(x, z) + y + 1.0, z - 0.15]} rotation={r + 1.2} />
    </group>)}
  </group>
}

const ghostSpots: [number, number, number, number][] = [
  [-19.5, 1.45, -18.6, 0.18], [22.7, 1.6, -21.8, -0.32], [-20.6, 1.35, -63.8, 0.42],
]

function PeekingGhost({ index, position, rotation }: { index: number; position: [number, number, number]; rotation: number }) {
  const root = useRef<THREE.Group>(null)
  const body = useMemo(() => new THREE.MeshStandardMaterial({ color: '#dcecff', emissive: '#75a5cf', emissiveIntensity: 1.5, transparent: true, opacity: 0.72, roughness: 0.32, depthWrite: false }), [])
  const eye = useMemo(() => new THREE.MeshBasicMaterial({ color: '#9ed8ff', toneMapped: false }), [])
  const vanished = useRef(false)
  useFrame(({ clock }) => {
    if (!root.current || vanished.current) return
    const dx = seq.roam.x - position[0]
    const dz = seq.roam.z - position[2]
    if (seq.exploration.entered && Math.hypot(dx, dz) < 5.4) {
      vanished.current = true
      seq.halloween.ghostsSeen[index] = true
      root.current.visible = false
      return
    }
    root.current.visible = seq.reveal.trees > 0.35 && !seq.halloween.ghostsSeen[index]
    root.current.position.y = position[1] + Math.sin(clock.elapsedTime * 0.8 + index) * 0.045
  })
  return <group ref={root} position={position} rotation={[0, rotation, 0]}>
    <mesh material={body} castShadow><sphereGeometry args={[0.42, 18, 14]} /></mesh>
    <mesh material={body} position={[0, -0.62, 0]} scale={[0.88, 1.2, 0.7]}><coneGeometry args={[0.52, 1.45, 16]} /></mesh>
    <mesh material={eye} position={[-0.14, 0.05, 0.36]}><sphereGeometry args={[0.045, 8, 6]} /></mesh>
    <mesh material={eye} position={[0.14, 0.05, 0.36]}><sphereGeometry args={[0.045, 8, 6]} /></mesh>
    <pointLight color="#7fc7ff" intensity={0.26} distance={2.5} position={[0, 0.1, 0.3]} />
  </group>
}

export function TreePeekingGhosts() {
  return <group>{ghostSpots.map(([x, y, z, r], i) => <PeekingGhost key={i} index={i} position={[x, y, z]} rotation={r} />)}</group>
}
