import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq } from '../animations/sequence'
import { createGlowTexture, createMoonTexture } from '../utils/proceduralTextures'

export const MOON_POSITION: [number, number, number] = [9, 36, -100]
export const MOON_RADIUS = 31

/** The gigantic full moon: procedural maria + craters, an additive halo and a wide atmospheric bloom. */
export function Moon() {
  const surface = useRef<THREE.MeshBasicMaterial>(null)
  const halo = useRef<THREE.SpriteMaterial>(null)
  const bloom = useRef<THREE.SpriteMaterial>(null)
  const sphere = useRef<THREE.Mesh>(null)
  const moonMap = useMemo(() => createMoonTexture(1024, 512), [])
  const glowMap = useMemo(() => createGlowTexture(), [])

  useFrame(({ clock }) => {
    const r = seq.reveal.moon * (1 - seq.ending.moonFade)
    // slow "breathing" so the moon never feels like a static sticker
    const breathe = 0.97 + Math.sin(clock.elapsedTime * 0.35) * 0.03
    surface.current?.color.setScalar(r * 0.86)
    if (halo.current) halo.current.opacity = r * 0.85 * breathe
    if (bloom.current) bloom.current.opacity = r * 0.4 * breathe
    if (sphere.current) sphere.current.rotation.y = 1.9 + clock.elapsedTime * 0.004
  })

  return (
    <group position={MOON_POSITION}>
      <mesh ref={sphere} renderOrder={-5}>
        <sphereGeometry args={[MOON_RADIUS, 128, 96]} />
        <meshBasicMaterial ref={surface} map={moonMap} color="#000000" fog={false} toneMapped={false} />
      </mesh>
      <sprite scale={[MOON_RADIUS * 4.4, MOON_RADIUS * 4.4, 1]} position={[0, 0, -4]} renderOrder={-6}>
        <spriteMaterial ref={halo} map={glowMap} color="#b9d6f2" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} fog={false} toneMapped={false} />
      </sprite>
      <sprite scale={[MOON_RADIUS * 10, MOON_RADIUS * 10, 1]} position={[0, 0, -8]} renderOrder={-7}>
        <spriteMaterial ref={bloom} map={glowMap} color="#5f86ad" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} fog={false} toneMapped={false} />
      </sprite>
    </group>
  )
}
