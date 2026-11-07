import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { seq, smoothstep } from '../animations/sequence'
import { ritualPower } from '../animations/ritualPower'
import { createFogTexture } from '../utils/proceduralTextures'

const colors = ['#a275ff', '#ff7353', '#75ffd1']

/** Local environmental response, driven by the same clock as the performers. */
export function RitualAtmosphere() {
  const fog = useRef<(THREE.Sprite | null)[]>([])
  const light = useRef<THREE.PointLight>(null)
  const hues = useMemo(() => colors.map(color => new THREE.Color(color)), [])
  const shoot = useRef<THREE.Group>(null)
  const time = useRef(0)
  const texture = useMemo(() => createFogTexture(32), [])
  const stem = useMemo(() => new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(-0.06, 0.35, 0), new THREE.Vector3(0.08, 0.75, 0), new THREE.Vector3(0, 1.1, 0),
  ]), 24, 0.025, 8, false), [])
  useEffect(() => () => { texture.dispose(); stem.dispose() }, [texture, stem])
  useFrame((_, delta) => {
    time.current += Math.min(delta, 0.05)
    const t = time.current
    let red = 0, green = 0, blue = 0, total = 0
    for (let i = 0; i < 3; i++) {
      const power = ritualPower(i, seq.exploration.storyProgress, seq.ending.progress, seq.ending.outcome, seq.ending.started)
      const sprite = fog.current[i]
      if (sprite) {
        const angle = t * 0.17 + i * Math.PI * 2 / 3
        const radius = 4.5 - power * 2.5
        sprite.position.set(Math.cos(angle) * radius, 0.35 + power * 0.65, Math.sin(angle) * radius)
        sprite.material.opacity = power * 0.15
        sprite.material.rotation = Math.sin(t * 0.15 + i) * 0.15
        sprite.visible = power > 0.01
      }
      red += hues[i].r * power; green += hues[i].g * power; blue += hues[i].b * power; total += power
    }
    if (light.current) {
      const divisor = Math.max(0.001, total)
      light.current.color.setRGB(red / divisor, green / divisor, blue / divisor)
      light.current.intensity = Math.min(1.6, total) * 3.4
    }
    const growth = seq.ending.outcome === 'success' ? smoothstep(0.84, 0.96, seq.ending.progress) : 0
    if (shoot.current) {
      shoot.current.visible = growth > 0.001
      shoot.current.scale.set(growth, growth, growth)
      shoot.current.rotation.z = Math.sin(t * 0.8) * 0.025 * (1 - growth)
    }
  })
  return <group position={[0, 0, -81]}>
    {colors.map((color, i) => <group key={color}>
      <sprite ref={node => { fog.current[i] = node }} scale={[6, 1.5, 1]} visible={false}>
        <spriteMaterial map={texture} color={color} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>

    </group>)}
    <pointLight ref={light} position={[0, 1.6, 0]} intensity={0} distance={9} decay={2} />
    <group ref={shoot} position={[0, 0.5, 1.7]} visible={false}>
      <mesh geometry={stem}><meshStandardMaterial color="#7baf66" emissive="#3d803b" emissiveIntensity={0.7} roughness={0.8} /></mesh>
      {[-1, 1].map(side => <mesh key={side} position={[side * 0.18, side < 0 ? 0.5 : 0.78, 0]} rotation={[0.2, 0, -side * 0.65]} scale={[0.23, 0.1, 0.055]}>
        <sphereGeometry args={[1, 16, 10]} /><meshStandardMaterial color="#a4ce79" emissive="#6c9e4a" emissiveIntensity={0.8} roughness={0.7} />
      </mesh>)}
    </group>
  </group>
}
