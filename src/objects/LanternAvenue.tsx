import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { seq } from '../animations/sequence'
import { batchStaticMeshes } from '../utils/batchStaticMeshes'
import { groundHeight } from './Ground'

export const lanternObstacles = Array.from({ length: 10 }, (_, i) => ({ x: (i % 2 ? 1 : -1) * (6.8 + Math.floor(i / 2) * 0.45), z: 9 - Math.floor(i / 2) * 16, radius: 0.45 }))

/** A quiet procession of funeral lanterns leads visitors through the grounds.
 * Shared materials and baked geometry keep the whole avenue to five draw calls. */
export function LanternAvenue() {
  const group = useRef<THREE.Group>(null)
  const scene = useMemo(() => {
    const root = new THREE.Group()
    const iron = new THREE.MeshStandardMaterial({ color: '#282c30', roughness: 0.62, metalness: 0.7 })
    const stone = new THREE.MeshStandardMaterial({ color: '#626762', roughness: 0.98 })
    const wax = new THREE.MeshStandardMaterial({ color: '#c8b798', roughness: 0.9 })
    const flame = new THREE.MeshBasicMaterial({ color: '#ffd099', toneMapped: false })
    const size = 64, data = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const n = (y * size + x) * 4, r = Math.hypot((x - 31.5) / 31.5, (y - 31.5) / 31.5)
      data[n] = 255; data[n + 1] = 147; data[n + 2] = 61
      data[n + 3] = Math.round(Math.pow(Math.max(0, 1 - r), 3) * 105)
    }
    const texture = new THREE.DataTexture(data, size, size); texture.needsUpdate = true
    const glow = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false })
    for (const material of [glow, flame]) {
      material.onBeforeCompile = shader => {
        shader.vertexShader = 'varying vec3 lanternWorld;\n' + shader.vertexShader
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n lanternWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;')
        shader.fragmentShader = 'varying vec3 lanternWorld;\n' + shader.fragmentShader
        shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', 'gl_FragColor.rgb *= 0.4 + 0.6 * (1.0 - smoothstep(5.0, 13.0, distance(lanternWorld, cameraPosition)));\n#include <dithering_fragment>')
      }
      material.customProgramCacheKey = () => 'lantern-approach-v1'
    }
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y, z); root.add(mesh); return mesh
    }
    for (let i = 0; i < 5; i++) for (const side of [-1, 1]) {
      const x = side * (6.8 + i * 0.45), z = 9 - i * 16, y = groundHeight(x, z)
      add(new THREE.BoxGeometry(0.58, 0.22, 0.58), stone, x, y + 0.11, z)
      add(new THREE.CylinderGeometry(0.055, 0.09, 2.1, 8), iron, x, y + 1.2, z)
      add(new THREE.BoxGeometry(0.46, 0.08, 0.46), iron, x, y + 2.26, z)
      const roof = add(new THREE.ConeGeometry(0.4, 0.3, 4), iron, x, y + 2.98, z); roof.rotation.y = Math.PI / 4
      add(new THREE.SphereGeometry(0.06, 8, 6), iron, x, y + 3.18, z)
      for (const dx of [-0.19, 0.19]) for (const dz of [-0.19, 0.19]) add(new THREE.BoxGeometry(0.026, 0.56, 0.026), iron, x + dx, y + 2.57, z + dz)
      add(new THREE.CylinderGeometry(0.075, 0.08, 0.25, 8), wax, x, y + 2.43, z)
      const wick = add(new THREE.SphereGeometry(0.055, 8, 6), flame, x, y + 2.62, z); wick.scale.set(0.7, 1.9, 0.7)
      // Crossed soft halos remain visible from either side without extra lights or shadows.
      for (const angle of [0, Math.PI / 2]) {
        const halo = add(new THREE.PlaneGeometry(1.8, 1.8), glow, x, y + 2.63, z); halo.rotation.y = angle
      }
      const pool = add(new THREE.PlaneGeometry(4.5, 4.5), glow, x, y + 0.035, z); pool.rotation.x = -Math.PI / 2
    }
    batchStaticMeshes(root)
    return { root, texture, materials: [iron, stone, wax, flame, glow] }
  }, [])
  useFrame(() => { if (group.current) group.current.visible = seq.reveal.gate > 0.15 })
  useEffect(() => () => {
    scene.root.traverse(node => { if (node instanceof THREE.Mesh) node.geometry.dispose() })
    scene.materials.forEach(material => material.dispose()); scene.texture.dispose()
  }, [scene])
  return <group ref={group}><primitive object={scene.root} /></group>
}
