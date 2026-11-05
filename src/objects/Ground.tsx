import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq } from '../animations/sequence'
import { createGroundTexture } from '../utils/proceduralTextures'

export function groundHeight(x: number, z: number) {
  const broad = Math.sin(x * 0.17 + z * 0.11) * 0.28
  const ripple = Math.sin(x * 0.61 - z * 0.42) * 0.08
  const hollow = Math.cos(x * 0.31 + z * 0.36) * 0.12
  // keep a level apron at the threshold so the gate never floats or sinks
  const near = Math.min(1, Math.hypot(x, z + 8) / 14)
  return (broad + ripple + hollow) * (0.2 + 0.8 * near)
}

export function Ground() {
  const material = useRef<THREE.MeshStandardMaterial>(null)
  const textures = useMemo(() => createGroundTexture(), [])
  const geometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(260, 260, 128, 128)
    const pos = g.attributes.position
    for (let i = 0; i < pos.count; i += 1) {
      pos.setZ(i, groundHeight(pos.getX(i), -pos.getY(i)))
    }
    pos.needsUpdate = true
    g.computeVertexNormals()
    return g
  }, [])

  useFrame(() => {
    const reveal = seq.reveal.fog * 0.8 + 0.2 * seq.reveal.trees
    const illumination = 0.18 + reveal * 0.82
    if (material.current) {
      material.current.color.setRGB(illumination * 0.42, illumination * 0.46, illumination * 0.43)
      material.current.emissive.setRGB(reveal * 0.005, reveal * 0.009, reveal * 0.014)
    }
  })

  return (
    <mesh geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <meshStandardMaterial ref={material} map={textures.map} bumpMap={textures.bumpMap} bumpScale={0.18} roughness={0.96} metalness={0.01} />
    </mesh>
  )
}
