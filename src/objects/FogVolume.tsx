import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq, smoothstep } from '../animations/sequence'
import { createFogTexture } from '../utils/proceduralTextures'

interface Bank {
  x: number
  y: number
  z: number
  w: number
  h: number
  speed: number
  base: number
  tex: number
  phase: number
}

const rand = (i: number, k: number) => {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453
  return s - Math.floor(s)
}

/** Fades sprites that get too close to the lens so passing through fog never blows out the frame. */
function nearFade(sprite: THREE.Sprite, camera: THREE.Camera) {
  const d = sprite.position.distanceTo(camera.position)
  return smoothstep(2.5, 9, d)
}

/**
 * Low fog banks crawling across the whole grounds, plus a dense river of mist
 * that is pushed out through the gate as the leaves swing open.
 */
export function FogVolume() {
  const { camera } = useThree()
  const textures = useMemo(() => [0, 1, 2].map((i) => createFogTexture(i * 5 + 2)), [])

  const groundBanks = useMemo<Bank[]>(
    () =>
      Array.from({ length: 34 }, (_, i) => ({
        x: (rand(i, 1) - 0.5) * 120,
        y: 0.5 + rand(i, 2) * 1.6,
        z: 30 - rand(i, 3) * 105,
        w: 22 + rand(i, 4) * 30,
        h: 3.2 + rand(i, 5) * 3.4,
        speed: (rand(i, 6) < 0.5 ? -1 : 1) * (0.18 + rand(i, 7) * 0.4),
        base: 0.025 + rand(i, 8) * 0.04,
        tex: i % 3,
        phase: rand(i, 9) * 6.28,
      })),
    [],
  )

  const gateBanks = useMemo<Bank[]>(
    () =>
      Array.from({ length: 20 }, (_, i) => ({
        x: (rand(i, 11) - 0.5) * 11,
        y: 0.7 + rand(i, 12) * 1.8,
        z: -22 + rand(i, 13) * 26,
        w: 9 + rand(i, 14) * 9,
        h: 2.6 + rand(i, 15) * 2.4,
        speed: 0.9 + rand(i, 16) * 1.2,
        base: 0.04 + rand(i, 17) * 0.05,
        tex: i % 3,
        phase: rand(i, 18) * 6.28,
      })),
    [],
  )

  const groundRefs = useRef<(THREE.Sprite | null)[]>([])
  const gateRefs = useRef<(THREE.Sprite | null)[]>([])

  useFrame(({ clock }, delta) => {
    const dt = Math.min(delta, 0.05)
    const t = clock.elapsedTime
    const fog = seq.reveal.fog

    groundBanks.forEach((b, i) => {
      const s = groundRefs.current[i]
      if (!s) return
      s.position.x += b.speed * dt
      if (s.position.x > 70) s.position.x = -70
      if (s.position.x < -70) s.position.x = 70
      s.position.y = b.y + Math.sin(t * 0.12 + b.phase) * 0.12
      const mat = s.material as THREE.SpriteMaterial
      mat.opacity = b.base * fog * (1 - seq.ending.fogFade) * (0.85 + Math.sin(t * 0.2 + b.phase) * 0.15) * nearFade(s, camera)
    })

    // mist rolling out of the entrance: strength follows the gate and keeps flowing while it's open
    const flow = smoothstep(0.02, 0.5, seq.gateOpen)
    gateBanks.forEach((b, i) => {
      const s = gateRefs.current[i]
      if (!s) return
      s.position.z += b.speed * dt * (0.25 + flow * 1.7)
      s.position.x += Math.sin(t * 0.3 + b.phase) * dt * 0.35
      if (s.position.z > 10) s.position.z = -24
      // fade at both ends of its travel so the loop is invisible
      const travel = (s.position.z + 24) / 34
      const edge = Math.sin(Math.min(1, Math.max(0, travel)) * Math.PI)
      const mat = s.material as THREE.SpriteMaterial
      mat.opacity = b.base * fog * (1 - seq.ending.fogFade) * (0.3 + flow * 0.9) * edge * nearFade(s, camera)
    })
  })

  return (
    <group>
      {groundBanks.map((b, i) => (
        <sprite
          key={`g${i}`}
          ref={(el) => {
            groundRefs.current[i] = el
          }}
          position={[b.x, b.y, b.z]}
          scale={[b.w, b.h, 1]}
        >
          <spriteMaterial map={textures[b.tex]} color="#9c9282" transparent opacity={0} depthWrite={false} />
        </sprite>
      ))}
      {gateBanks.map((b, i) => (
        <sprite
          key={`m${i}`}
          ref={(el) => {
            gateRefs.current[i] = el
          }}
          position={[b.x, b.y, b.z]}
          scale={[b.w, b.h, 1]}
        >
          <spriteMaterial map={textures[b.tex]} color="#a49b8b" transparent opacity={0} depthWrite={false} />
        </sprite>
      ))}
    </group>
  )
}
