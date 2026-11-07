import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq } from '../animations/sequence'
import { GATE_Z } from './CemeteryGate'
import { groundHeight } from './Ground'
import { newGhostEncounter, updateGhostEncounter } from './ghostEncounter'
import { TreeOfferings } from './TreeOfferings'
import { TreeCanopyDecor } from './TreeCanopyDecor'

const pumpkinSpots: [number, number, number][] = [
  [-7.4, -8.6, 0.2], [-8.1, -9.1, 0.5], [7.6, -8.9, -0.35],
  [-10.1, -25.5, 0.6], [-10.7, -26.1, -0.3], [11.7, -35.8, -0.4],
  [-14.1, -49, 0.25], [15.2, -58.2, -0.6], [-10.6, -69, 0.5], [10.7, -73, -0.2],
  [-4.6, -77, 0.25], [4.7, -78, -0.3], [-5.4, -78.2, 0.4], [5.3, -76.8, -0.5],
]

function Pumpkin({ scale = 1 }: { scale?: number }) {
  const geometry = useMemo(() => {
    const g = new THREE.SphereGeometry(0.62, 32, 20)
    const positions = g.attributes.position
    const colors: number[] = []
    const color = new THREE.Color()
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i)
      const a = Math.atan2(z, x), rib = 1 + Math.cos(a * 10) * 0.085
      positions.setXYZ(i, x * rib, y * 0.82, z * rib * 0.92)
      color.set('#c65b19').multiplyScalar(0.85 + Math.cos(a * 10) * 0.13 + Math.sin(y * 61 + a * 19) * 0.04)
      colors.push(color.r, color.g, color.b)
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    g.computeVertexNormals()
    return g
  }, [])
  const mouth = useMemo(() => {
    const shape = new THREE.Shape()
    shape.moveTo(-0.29, -0.12); shape.lineTo(-0.14, -0.17); shape.lineTo(-0.09, -0.1)
    shape.lineTo(-0.04, -0.18); shape.lineTo(0.1, -0.18); shape.lineTo(0.14, -0.12)
    shape.lineTo(0.2, -0.18); shape.lineTo(0.29, -0.12); shape.lineTo(0.2, -0.28)
    shape.lineTo(0.06, -0.32); shape.lineTo(0.02, -0.25); shape.lineTo(-0.04, -0.25)
    shape.lineTo(-0.09, -0.31); shape.lineTo(-0.2, -0.27); shape.closePath()
    return new THREE.ShapeGeometry(shape)
  }, [])
  useFrame(({ clock }) => {
    glow.opacity = (0.8 + Math.sin(clock.elapsedTime * 8 + scale * 9) * 0.1) * seq.reveal.light
  })
  const stem = useMemo(() => new THREE.MeshStandardMaterial({ color: '#3d2c1f', roughness: 1 }), [])
  const glow = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffb14e', transparent: true, opacity: 0.88, toneMapped: false }), [])
  return (
    <group scale={scale}>
      <mesh geometry={geometry} castShadow receiveShadow><meshStandardMaterial vertexColors roughness={0.82} /></mesh>
      <mesh material={stem} position={[0, 0.62, -0.02]} rotation={[0.12, 0.15, -0.08]} castShadow><cylinderGeometry args={[0.075, 0.11, 0.32, 8]} /></mesh>
      <group position={[0, 0.03, 0.575]}>
        <mesh material={glow} position={[-0.18, 0.07, 0]} rotation={[0, 0, 0.12]}><coneGeometry args={[0.1, 0.14, 3]} /></mesh>
        <mesh material={glow} position={[0.18, 0.07, 0]} rotation={[0, 0, -0.12]}><coneGeometry args={[0.1, 0.14, 3]} /></mesh>
        <mesh material={glow} geometry={mouth} position={[0, 0, -0.01]} />
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
    <pointLight color="#ff9b51" intensity={1.5} distance={8} position={[-6.7, 0.8, GATE_Z - 0.7]} />
    <pointLight color="#ff9b51" intensity={1.2} distance={8} position={[6.7, 0.8, GATE_Z - 0.7]} />
    {pumpkinSpots.map(([x, z, r], i) => {
      const scale = 0.68 + (i % 4) * 0.1
      return <group key={`pumpkin-${i}`} position={[x, groundHeight(x, z) + 0.5 * scale, z]} rotation={[0, r, 0]}><Pumpkin scale={scale} /></group>
    })}
    <CandleCluster position={[-3.9, groundHeight(-3.9, -78) + 0.08, -78]} scale={1.2} />
    <CandleCluster position={[4.1, groundHeight(4.1, -79) + 0.08, -79]} scale={1.1} />
    <TreeWeb position={[-5.8, 2.8, GATE_Z + 0.1]} rotation={0.2} />
    <TreeWeb position={[5.8, 3.2, GATE_Z + 0.1]} rotation={-0.2} />
    <HangingSpider position={[5.6, 2.8, GATE_Z + 0.2]} scale={1.2} />
    <CandleCluster position={[-6.4, groundHeight(-6.4, GATE_Z - 0.65) + 0.08, GATE_Z - 0.65]} scale={1.1} />
    <CandleCluster position={[6.5, groundHeight(6.5, GATE_Z - 0.7) + 0.08, GATE_Z - 0.7]} scale={0.92} />
    <group position={[2.4, groundHeight(2.4, -42) + 0.35, -42]} rotation={[0, -0.25, 0]}><Skull size={1} /></group>
    <group position={[-13, groundHeight(-13, -36) + 0.12, -36]}><Skull size={0.7} /></group>
    {groundSpiders.map(([x, z], i) => <Spider key={`ground-spider-${i}`} position={[x, groundHeight(x, z) + 0.16, z]} scale={0.9 + (i % 2) * 0.25} />)}
    {treeDecor.map(([x, z, y, r], i) => <group key={`tree-decor-${i}`}>
      <TreeOfferings position={[x, groundHeight(x, z), z]} index={i} />
      <TreeCanopyDecor position={[x, groundHeight(x, z), z]} index={i} />
      <HangingTreeCharm position={[x + 0.35, groundHeight(x, z) + y, z + 0.4]} rotation={r} />
      <TreeWeb position={[x - 0.35, groundHeight(x, z) + y - 0.8, z + 0.25]} rotation={r + 0.3} />
      <HangingSpider position={[x - 0.2, groundHeight(x, z) + y - 0.25, z + 0.34]} scale={0.72 + (i % 3) * 0.13} />
      <Raven position={[x + 0.8, groundHeight(x, z) + y + 1.0, z - 0.15]} rotation={r + 1.2} />
    </group>)}
  </group>
}

const ghostSpots: [number, number, number, number][] = [
  [-16.6, 1.7, -18.2, 0.18], [19.4, 1.9, -21.5, -0.32], [-17.4, 1.6, -63.5, 0.42],
]

function PeekingGhost({ index, position, rotation }: { index: number; position: [number, number, number]; rotation: number }) {
  const root = useRef<THREE.Group>(null)
  const body = useMemo(() => new THREE.MeshStandardMaterial({ color: '#aebfca', emissive: '#617f93', emissiveIntensity: 0.32, transparent: true, opacity: 0, roughness: 0.96, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true }), [])
  const eye = useMemo(() => new THREE.MeshBasicMaterial({ color: '#101923', transparent: true, opacity: 0, depthWrite: false }), [])
  const encounter = useRef(newGhostEncounter())
  const forward = useMemo(() => new THREE.Vector3(), [])
  const toward = useMemo(() => new THREE.Vector3(), [])
  const drape = useMemo(() => {
    const profile = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.52, -1.3, 0), new THREE.Vector3(0.39, -0.95, 0),
      new THREE.Vector3(0.28, -0.6, 0), new THREE.Vector3(0.42, -0.28, 0),
      new THREE.Vector3(0.26, -0.05, 0), new THREE.Vector3(0.27, 0.19, 0),
      new THREE.Vector3(0.17, 0.4, 0), new THREE.Vector3(0, 0.47, 0),
    ])
    const g = new THREE.LatheGeometry(profile.getPoints(40).map(p => new THREE.Vector2(p.x, p.y)), 40)
    const p = g.attributes.position
    for (let i = 0; i < p.count; i++) {
      const angle = Math.atan2(p.getZ(i), p.getX(i))
      const fold = 1 + Math.sin(angle * 8 + p.getY(i)) * 0.045
      p.setXYZ(i, p.getX(i) * fold, p.getY(i) + Math.sin(angle * 6) * 0.018, p.getZ(i) * fold * 0.85)
    }
    g.computeVertexNormals(); return g
  }, [])
  useFrame(({ clock, camera }, delta) => {
    if (!root.current) return
    toward.set(position[0], groundHeight(position[0], position[2]) + position[1], position[2]).sub(camera.position)
    const distance = toward.length()
    camera.getWorldDirection(forward)
    const gaze = forward.dot(toward.normalize())
    const state = encounter.current
    if (seq.halloween.ghostsSeen[index]) state.gone = true
    updateGhostEncounter(state, delta, distance, gaze, seq.exploration.entered && seq.reveal.trees > 0.8 && !seq.exploration.storyStarted, index)
    if (state.gone) seq.halloween.ghostsSeen[index] = true
    root.current.visible = state.opacity > 0.005
    body.opacity = state.opacity; eye.opacity = state.opacity
    root.current.position.y = groundHeight(position[0], position[2]) + position[1] + Math.sin(clock.elapsedTime * 0.8 + index) * 0.04
    root.current.position.x = position[0] + (index % 2 ? 1 : -1) * (1 - state.opacity / 0.66) * 0.55
    root.current.rotation.z = (index % 2 ? -1 : 1) * state.opacity * 0.16
    root.current.rotation.y = Math.atan2(camera.position.x - position[0], camera.position.z - position[2])
  })
  return <group ref={root} position={position} rotation={[0, rotation, 0]} visible={false}>
    <mesh material={body} geometry={drape} />
    {[-1, 1].map(side => <group key={side}>
      <mesh material={body} position={[side * 0.36, -0.5, 0.02]} rotation={[0.1, 0, side * 0.16]} scale={[1, 1.5, 0.8]}><capsuleGeometry args={[0.105, 0.35, 6, 12]} /></mesh>
      <mesh material={eye} position={[side * 0.1, 0.11, 0.235]} scale={[0.8, 1.35, 0.25]} rotation={[0, 0, side * -0.15]}><sphereGeometry args={[0.055, 12, 10]} /></mesh>
    </group>)}
    <mesh material={eye} position={[0, -0.06, 0.223]} scale={[0.5, 1.5, 0.22]}><sphereGeometry args={[0.04, 12, 10]} /></mesh>
  </group>
}

export function TreePeekingGhosts() {
  return <group>{ghostSpots.map(([x, y, z, r], i) => <PeekingGhost key={i} index={i} position={[x, y, z]} rotation={r} />)}</group>
}
