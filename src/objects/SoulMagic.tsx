import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq } from '../animations/sequence'
import { ritualPower } from '../animations/ritualPower'
import { createGlowTexture } from '../utils/proceduralTextures'

const colors = ['#ac7bff', '#ff7051', '#6bffc2']
const origins = [[-2.85, 2.5, 3.6], [2.85, 2.5, 3.95], [0, 4.45, -1.3]]
const vertexShader = `
  attribute float seed;
  uniform float time, power, pointScale, pixelRatio;
  uniform vec3 origin;
  varying float alpha;
  void main() {
    float t = fract(seed * 0.6180339 + time * 0.23);
    vec3 destination = vec3(0.0, 3.85, -0.2);
    vec3 p = mix(origin, destination, t);
    p.y += sin(t * 3.14159) * 0.65;
    float angle = t * 18.85 - time * 2.8 + seed * 2.39996;
    float radius = sin(t * 3.14159) * (0.28 + fract(seed * 0.713) * 0.35);
    p += vec3(cos(angle), sin(angle), sin(angle + 0.8)) * radius;
    vec4 view = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * view;
    gl_PointSize = min(70.0, pointScale * pixelRatio / max(1.0, -view.z));
    alpha = power * sin(t * 3.14159) * (0.5 + fract(seed * 0.31) * 0.5);
  }
`
const fragmentShader = `
  uniform vec3 color;
  uniform float softness;
  varying float alpha;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float glow = exp(-r * r * softness) * (1.0 - smoothstep(0.65, 1.0, r));
    gl_FragColor = vec4(color, glow * alpha);
  }
`

function Spell({ index }: { index: number }) {
  const root = useRef<THREE.Group>(null)
  const charge = useRef<THREE.SpriteMaterial>(null)
  const chargeSprite = useRef<THREE.Sprite>(null)
  const time = useRef(0)
  const { geometry, mist, sparks, texture } = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(240 * 3), 3))
    geometry.setAttribute('seed', new THREE.Float32BufferAttribute(Array.from({ length: 240 }, (_, i) => i), 1))
    const makeMaterial = (pointScale: number, softness: number) => new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, power: { value: 0 }, origin: { value: new THREE.Vector3(...origins[index]) }, color: { value: new THREE.Color(colors[index]) }, pointScale: { value: pointScale }, softness: { value: softness }, pixelRatio: { value: 1 } },
      vertexShader, fragmentShader, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    })
    return { geometry, mist: makeMaterial(380, 3.5), sparks: makeMaterial(30, 7), texture: createGlowTexture(64) }
  }, [index])
  useEffect(() => () => { geometry.dispose(); mist.dispose(); sparks.dispose(); texture.dispose() }, [geometry, mist, sparks, texture])
  useFrame(({ gl }, delta) => {
    const power = ritualPower(index, seq.exploration.storyProgress, seq.ending.progress, seq.ending.outcome, seq.ending.started)
    if (root.current) root.current.visible = power > 0.002
    if (power <= 0.002) return
    time.current += Math.min(delta, 0.05)
    for (const material of [mist, sparks]) {
      material.uniforms.time.value = time.current
      material.uniforms.power.value = power * (material === mist ? 0.028 : 0.9)
      material.uniforms.pixelRatio.value = gl.getPixelRatio()
    }
    if (charge.current) charge.current.opacity = power * 0.75
    if (chargeSprite.current) chargeSprite.current.scale.setScalar(1.3 + Math.sin(time.current * 3) * 0.16)
  })
  return <group ref={root} visible={false}>
    <points geometry={geometry} material={mist} frustumCulled={false} />
    <points geometry={geometry} material={sparks} frustumCulled={false} />
    <sprite ref={chargeSprite} position={origins[index] as [number, number, number]} scale={1.3}>
      <spriteMaterial ref={charge} map={texture} color={colors[index]} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
    </sprite>
  </group>
}

/** Six GPU particle batches form curling vapor, sparks, and a converging spell above the stone. */
export function SoulMagic() {
  const vortex = useRef<THREE.Group>(null)
  const halo = useRef<THREE.SpriteMaterial>(null)
  const ringMaterials = useRef<(THREE.MeshBasicMaterial | null)[]>([])
  const time = useRef(0)
  const texture = useMemo(() => createGlowTexture(128), [])
  useEffect(() => () => texture.dispose(), [texture])
  useFrame((_, delta) => {
    time.current += Math.min(delta, 0.05)
    let power = 0
    for (let i = 0; i < 3; i++) power = Math.max(power, ritualPower(i, seq.exploration.storyProgress, seq.ending.progress, seq.ending.outcome, seq.ending.started))
    if (vortex.current) {
      vortex.current.visible = power > 0.002
      vortex.current.rotation.y = time.current * 0.65
      vortex.current.rotation.z = Math.sin(time.current * 0.5) * 0.2
      vortex.current.scale.setScalar(0.75 + power * 0.25)
    }
    ringMaterials.current.forEach(material => { if (material) material.opacity = power * 0.3 })
    if (halo.current) halo.current.opacity = power * 0.5
  })
  return <group position={[0, 0, -83]}>
    {[0, 1, 2].map(index => <Spell key={index} index={index} />)}
    <group ref={vortex} position={[0, 3.85, -0.2]} visible={false}>
      {[0, 1, 2].map(i => <mesh key={i} rotation={[Math.PI * 0.3 + i * 0.8, i * 0.6, i]}>
        <torusGeometry args={[0.58 + i * 0.12, 0.018, 6, 64, Math.PI * 1.6]} />
        <meshBasicMaterial ref={material => { ringMaterials.current[i] = material }} color={colors[i]} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>)}
      <sprite scale={3}><spriteMaterial ref={halo} map={texture} color="#cbdfff" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} /></sprite>
    </group>
  </group>
}
