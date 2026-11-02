import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq } from '../animations/sequence'
import { createCloudTexture } from '../utils/proceduralTextures'

interface CloudSpec {
  x: number
  y: number
  z: number
  w: number
  h: number
  speed: number
  opacity: number
  tex: number
  tint: string
}

// Hand-placed so a few banks slide across the face of the moon while the rest layer the sky.
const clouds: CloudSpec[] = [
  { x: -84, y: 30, z: -86, w: 72, h: 15, speed: 0.36, opacity: 0.37, tex: 0, tint: '#1a2839' },
  { x: 76, y: 24, z: -83, w: 94, h: 19, speed: 0.27, opacity: 0.31, tex: 1, tint: '#1b2a3b' },
  { x: -32, y: 39, z: -91, w: 112, h: 23, speed: 0.18, opacity: 0.24, tex: 2, tint: '#203246' },
  { x: 108, y: 17, z: -75, w: 106, h: 19, speed: 0.43, opacity: 0.23, tex: 3, tint: '#23384b' },
  { x: -112, y: 18, z: -79, w: 104, h: 17, speed: 0.31, opacity: 0.26, tex: 0, tint: '#26394b' },
  { x: 26, y: 48, z: -96, w: 144, h: 27, speed: 0.13, opacity: 0.15, tex: 1, tint: '#1d2c40' },
  { x: -46, y: 12, z: -71, w: 118, h: 15, speed: 0.25, opacity: 0.2, tex: 2, tint: '#26394b' },
  { x: 64, y: 34, z: -68, w: 62, h: 13, speed: 0.54, opacity: 0.22, tex: 3, tint: '#2a4053' },
  { x: -6, y: 27, z: -89, w: 58, h: 11, speed: 0.42, opacity: 0.34, tex: 2, tint: '#172536' },
  { x: 132, y: 42, z: -88, w: 96, h: 18, speed: 0.2, opacity: 0.17, tex: 0, tint: '#203044' },
]

const WRAP = 170

export function CloudLayers() {
  const textures = useMemo(() => [0, 1, 2, 3].map((i) => createCloudTexture(i * 7 + 3, 256, 128)), [])
  const refs = useRef<(THREE.Sprite | null)[]>([])

  useFrame(({ camera, clock }, delta) => {
    const dt = Math.min(delta, 0.05)
    refs.current.forEach((sprite, i) => {
      if (!sprite) return
      const c = clouds[i]
      // Preserve the initial composition around the travelling camera. These
      // banks live between the viewer and the moon throughout the whole rail.
      const drift = ((c.x + clock.elapsedTime * c.speed + WRAP) % (WRAP * 2)) - WRAP
      sprite.position.set(
        camera.position.x + drift,
        camera.position.y + c.y - 2.15 + Math.sin(clock.elapsedTime * 0.12 + i * 2.1) * 0.9,
        camera.position.z + c.z - 34,
      )
      const mat = sprite.material as THREE.SpriteMaterial
      // a slow brightness pulse as if moonlight is leaking through thinner parts
      const pulse = 0.82 + Math.sin(clock.elapsedTime * 0.06 * (1 + i * 0.17) + i) * 0.18
      mat.opacity = c.opacity * seq.reveal.clouds * pulse
    })
  })

  return (
    <group>
      {clouds.map((c, i) => (
        <sprite
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          position={[c.x, c.y, c.z]}
          scale={[c.w, c.h, 1]}
          renderOrder={-4}
        >
          <spriteMaterial map={textures[c.tex]} color={c.tint} transparent opacity={0} depthWrite={false} fog={false} toneMapped={false} />
        </sprite>
      ))}
    </group>
  )
}
