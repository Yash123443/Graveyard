import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq } from '../animations/sequence'
import { createGlowTexture, createMoonDetailTexture, createMoonTexture } from '../utils/proceduralTextures'

export const MOON_POSITION: [number, number, number] = [9, 36, -100]
// Large enough to dominate the gate reveal, while leaving room for the sky and tree silhouettes.
export const MOON_RADIUS = 23

/** The gigantic full moon: procedural maria + craters, an additive halo and a wide atmospheric bloom. */
export function Moon() {
  const root = useRef<THREE.Group>(null)
  const surface = useRef<THREE.MeshBasicMaterial>(null)
  const halo = useRef<THREE.SpriteMaterial>(null)
  const bloom = useRef<THREE.SpriteMaterial>(null)
  const rim = useRef<THREE.SpriteMaterial>(null)
  const sphere = useRef<THREE.Mesh>(null)
  const moonMap = useMemo(() => createMoonTexture(1024, 512), [])
  const detailMap = useMemo(() => createMoonDetailTexture(1024, 512), [])
  const glowMap = useMemo(() => createGlowTexture(), [])

  useFrame(({ camera, clock }) => {
    const r = seq.reveal.moon * (1 - seq.ending.moonFade)
    // slow "breathing" so the moon never feels like a static sticker
    const breathe = 0.97 + Math.sin(clock.elapsedTime * 0.35) * 0.03
    surface.current?.color.setRGB(r * 0.83, r * 0.91, r)
    if (halo.current) halo.current.opacity = r * 0.42 * breathe
    if (bloom.current) bloom.current.opacity = r * 0.16 * breathe
    if (rim.current) rim.current.opacity = r * 0.22
    if (sphere.current) sphere.current.rotation.y = 1.9 + clock.elapsedTime * 0.004
    // The cemetery camera travels a long way into the grounds. Keep the moon
    // at its intended horizon distance rather than allowing the rail to pass it.
    root.current?.position.set(camera.position.x + 9, camera.position.y + 33.9, camera.position.z - 137)
  })

  return (
    <group ref={root} position={MOON_POSITION}>
      <mesh ref={sphere} renderOrder={-5}>
        <sphereGeometry args={[MOON_RADIUS, 128, 96]} />
        <meshBasicMaterial ref={surface} map={moonMap} alphaMap={detailMap} color="#000000" fog={false} toneMapped={false} />
      </mesh>
      {/* A tight, desaturated atmosphere follows the irregular lunar edge; the broad bloom stays deliberately faint. */}
      <sprite scale={[MOON_RADIUS * 2.38, MOON_RADIUS * 2.38, 1]} position={[0, 0, 1.2]} renderOrder={-6}>
        <spriteMaterial ref={rim} map={glowMap} color="#b8d5ef" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} fog={false} toneMapped={false} />
      </sprite>
      <sprite scale={[MOON_RADIUS * 4.8, MOON_RADIUS * 4.8, 1]} position={[0, 0, 3]} renderOrder={-7}>
        <spriteMaterial ref={halo} map={glowMap} color="#b9d6f2" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} fog={false} toneMapped={false} />
      </sprite>
      <sprite scale={[MOON_RADIUS * 9.5, MOON_RADIUS * 9.5, 1]} position={[0, 0, 5]} renderOrder={-8}>
        <spriteMaterial ref={bloom} map={glowMap} color="#5f86ad" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} fog={false} toneMapped={false} />
      </sprite>
    </group>
  )
}
