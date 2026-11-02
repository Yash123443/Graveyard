import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq } from '../animations/sequence'
import { MOON_POSITION } from './Moon'

/** Classic bat silhouette: one wing outline (extends +x), mirrored for the other side. */
function wingGeometry() {
  const s = new THREE.Shape()
  s.moveTo(0, 0.14)
  s.lineTo(0.5, 0.42)
  s.lineTo(1.15, 0.52)
  s.lineTo(2.1, 1.0) // wing tip
  s.quadraticCurveTo(1.92, 0.3, 1.66, 0.14)
  s.quadraticCurveTo(1.5, -0.2, 1.24, -0.32)
  s.quadraticCurveTo(0.98, -0.02, 0.7, -0.22)
  s.quadraticCurveTo(0.42, -0.14, 0.18, -0.3)
  s.lineTo(0, -0.22)
  s.closePath()
  return new THREE.ShapeGeometry(s, 8)
}

const FLOCK_SIZE = 10
const BAT_COUNT = FLOCK_SIZE * 3

interface Flight {
  active: boolean
  start: number
  duration: number
  x0: number
  x1: number
  y: number
  arc: number
  wobble: number
  z: number
  phase: number
  flapHz: number
  near: boolean
}

function Bat({ size, wing, material, setRef }: { size: number; wing: THREE.BufferGeometry; material: THREE.Material; setRef: (g: THREE.Group | null) => void }) {
  return (
    <group ref={setRef} scale={size} visible={false}>
      <mesh geometry={wing} material={material} name="wingR" />
      <group scale={[-1, 1, 1]}>
        <mesh geometry={wing} material={material} name="wingL" />
      </group>
      <mesh position={[0, 0.02, 0]} scale={[0.17, 0.4, 0.12]} material={material}>
        <sphereGeometry args={[1, 10, 8]} />
      </mesh>
      <mesh position={[0, 0.4, 0]} scale={[0.12, 0.13, 0.1]} material={material}>
        <sphereGeometry args={[1, 8, 6]} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * 0.09, 0.56, 0]} rotation={[0, 0, -s * 0.15]} material={material}>
          <coneGeometry args={[0.05, 0.2, 4]} />
        </mesh>
      ))}
    </group>
  )
}

/**
 * Two flocks that sweep across the face of the moon, launched by scroll.
 * Wings flap in the image plane, so each bat reads as a hard black silhouette.
 */
export function BatFlight() {
  const wing = useMemo(() => wingGeometry(), [])
  const material = useMemo(() => new THREE.MeshBasicMaterial({ color: '#010204', side: THREE.DoubleSide, fog: false, toneMapped: false }), [])
  const groups = useRef<(THREE.Group | null)[]>([])
  const flights = useRef<Flight[]>(
    Array.from({ length: BAT_COUNT }, () => ({ active: false, start: 0, duration: 1, x0: 0, x1: 0, y: 0, arc: 0, wobble: 0, z: 0, phase: 0, flapHz: 6, near: false })),
  )
  const sizes = useMemo(() => Array.from({ length: BAT_COUNT }, (_, i) => 0.55 + ((i * 37) % 11) / 11 * 0.85), [])
  const launched = useRef(0)
  const ambientLaunched = useRef(false)
  const nearLaunched = useRef(false)

  useFrame(({ camera, clock }) => {
    const now = clock.elapsedTime
    // One loose, distant group crosses as soon as the moon is revealed. Further
    // flocks still use the existing scroll milestones.
    if (!ambientLaunched.current && seq.reveal.moon > 0.72) {
      ambientLaunched.current = true
      seq.flock.id += 1
    }
    if (seq.exploration.entered && !nearLaunched.current) {
      nearLaunched.current = true
      seq.flock.id += 1
    }

    // launch the next flock whenever scroll crosses a trigger
    while (launched.current < seq.flock.id) {
      const flockIdx = launched.current % 3
      const rightToLeft = flockIdx !== 0
      const isNear = nearLaunched.current && launched.current === seq.flock.id - 1
      for (let i = 0; i < FLOCK_SIZE; i += 1) {
        const f = flights.current[flockIdx * FLOCK_SIZE + i]
        const r = (n: number) => Math.abs(Math.sin((i + 1) * 12.9898 + n * 78.233 + launched.current * 3.7)) % 1
        f.active = true
        f.near = isNear
        f.start = now + r(1) * 3.8 + i * 0.25
        f.duration = isNear ? 3.2 + r(2) * 2.1 : 7.2 + r(2) * 6.8
        const span = isNear ? 30 + r(9) * 18 : 106 + r(9) * 34
        f.x0 = (rightToLeft ? 1 : -1) * span
        f.x1 = (rightToLeft ? -1 : 1) * span
        f.y = isNear ? 3.4 + r(3) * 8.5 : MOON_POSITION[1] - 15 + r(3) * 31
        f.arc = isNear ? 0.8 + r(4) * 2.1 : 3 + r(4) * 7
        f.wobble = 0.6 + r(5) * 1.6
        f.z = isNear ? -2 + r(6) * 12 : -78 + r(6) * 25
        f.phase = r(7) * 6.28
        f.flapHz = 6.5 + r(8) * 4
      }
      launched.current += 1
    }

    flights.current.forEach((f, i) => {
      const g = groups.current[i]
      if (!g) return
      if (!f.active) {
        g.visible = false
        return
      }
      const p = (now - f.start) / f.duration
      if (p < 0) {
        g.visible = false
        return
      }
      if (p > 1) {
        f.active = false
        g.visible = false
        return
      }
      // Fade into the surrounding black at the ends of each route.
      g.visible = p > 0.035 && p < 0.965
      const dir = Math.sign(f.x1 - f.x0)
      const x = f.x0 + (f.x1 - f.x0) * p
      // lazy erratic path: big arc + fast flutter
      const y = f.y + Math.sin(p * Math.PI * 1.4 + f.phase) * f.arc + Math.sin(now * 3.1 + f.phase) * f.wobble * 0.5
      // Match the sky's fixed visual depth so the existing camera rail never
      // overtakes the flock before it crosses the moon.
      g.position.set(camera.position.x + x, camera.position.y + y - 2.15, camera.position.z + f.z - 34)
      const flap = Math.sin(now * f.flapHz * Math.PI * 2 + f.phase)
      const [r, l] = [g.children[0], g.children[1]]
      r.rotation.z = flap * 0.62 + 0.1
      l.rotation.z = -(flap * 0.62 + 0.1)
      // the whole animal rolls slightly and bobs against each flap
      g.rotation.z = dir * -0.12 + Math.cos(now * 1.9 + f.phase) * 0.12
      g.position.y += -flap * 0.12
    })
  })

  return (
    <group>
      {Array.from({ length: BAT_COUNT }, (_, i) => (
        <Bat
          key={i}
          size={sizes[i]}
          wing={wing}
          material={material}
          setRef={(g) => {
            groups.current[i] = g
          }}
        />
      ))}
    </group>
  )
}
