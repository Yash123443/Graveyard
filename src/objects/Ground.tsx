import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq } from '../animations/sequence'
import { createGroundTexture } from '../utils/proceduralTextures'

function naturalGroundHeight(x: number, z: number) {
  const broad = Math.sin(x * 0.17 + z * 0.11) * 0.28
  const ripple = Math.sin(x * 0.61 - z * 0.42) * 0.08
  const hollow = Math.cos(x * 0.31 + z * 0.36) * 0.12
  // keep a level apron at the threshold so the gate never floats or sinks
  const near = Math.min(1, Math.hypot(x, z + 8) / 14)
  return (broad + ripple + hollow) * (0.2 + 0.8 * near)
}

// Burial plots use a level soil bed, blended into the surrounding rolling terrain.
// All placement code and the rendered ground share this same height function.
const burialBeds: [number, number, number][] = [
  [-8.5, -24, 2.8], [10, -35, 2.8], [-12.5, -48, 2.8],
  [13.5, -58, 2.8], [-9, -68, 2.8], [9, -73, 2.8],
  [-16, -30, 3.5], [18, -43, 3.5], [-18, -57, 3.5], [17, -74, 3.5],
  [0, -83, 5.5],
]
function terrainHeight(x: number, z: number) {
  let height = naturalGroundHeight(x, z)
  for (const [cx, cz, radius] of burialBeds) {
    const distance = Math.hypot(x - cx, z - cz)
    const t = THREE.MathUtils.clamp((distance - radius) / 2.5, 0, 1)
    const blend = 1 - t * t * (3 - 2 * t)
    height = THREE.MathUtils.lerp(height, naturalGroundHeight(cx, cz), blend)
  }
  return height
}

// Match the actual triangulated ground, rather than the unsampled height curve.
// This prevents bases from hovering above the rendered surface between vertices.
export function groundHeight(x: number, z: number) {
 const step=260/128
 const ix=Math.floor((x+130)/step), iz=Math.floor((z+130)/step)
 const x0=ix*step-130,z0=iz*step-130
 const u=(x-x0)/step,v=(z-z0)/step
 const a=terrainHeight(x0,z0),b=terrainHeight(x0+step,z0),d=terrainHeight(x0,z0+step)
 if(u+v<=1)return a+(b-a)*u+(d-a)*v
 const c=terrainHeight(x0+step,z0+step)
 return c+(d-c)*(1-u)+(b-c)*(1-v)
}

export function Ground() {
  const material = useRef<THREE.MeshStandardMaterial>(null)
  const textures = useMemo(() => createGroundTexture(), [])
  const geometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(260, 260, 128, 128)
    const pos = g.attributes.position
    for (let i = 0; i < pos.count; i += 1) {
      pos.setZ(i, terrainHeight(pos.getX(i), -pos.getY(i)))
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
