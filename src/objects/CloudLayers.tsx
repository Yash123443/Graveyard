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
  { x: -70, y: 30, z: -58, w: 78, h: 22, speed: 0.55, opacity: 0.28, tex: 0, tint: '#334960' },
  { x: 40, y: 24, z: -62, w: 90, h: 24, speed: 0.38, opacity: 0.24, tex: 1, tint: '#30445a' },
  { x: -10, y: 38, z: -70, w: 120, h: 30, speed: 0.28, opacity: 0.17, tex: 2, tint: '#293d52' },
  { x: 95, y: 18, z: -74, w: 100, h: 20, speed: 0.46, opacity: 0.22, tex: 3, tint: '#293d52' },
  { x: -95, y: 17, z: -78, w: 110, h: 20, speed: 0.34, opacity: 0.21, tex: 0, tint: '#293d52' },
  { x: 20, y: 47, z: -90, w: 150, h: 34, speed: 0.2, opacity: 0.14, tex: 1, tint: '#27394b' },
  { x: -50, y: 12, z: -86, w: 120, h: 16, speed: 0.3, opacity: 0.18, tex: 2, tint: '#293d52' },
  { x: 70, y: 33, z: -52, w: 64, h: 16, speed: 0.62, opacity: 0.2, tex: 3, tint: '#334960' },
]

const WRAP = 170

export function CloudLayers() {
  const textures = useMemo(() => [0, 1, 2, 3].map((i) => createCloudTexture(i * 7 + 3, 256, 128)), [])
  const refs = useRef<(THREE.Sprite | null)[]>([])

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05)
    refs.current.forEach((sprite, i) => {
      if (!sprite) return
      const c = clouds[i]
      sprite.position.x += c.speed * dt
      if (sprite.position.x > WRAP) sprite.position.x = -WRAP
      const mat = sprite.material as THREE.SpriteMaterial
      // a slow brightness pulse as if moonlight is leaking through thinner parts
      const pulse = 0.88 + Math.sin(performance.now() * 0.00006 * (1 + i * 0.17) + i) * 0.12
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
