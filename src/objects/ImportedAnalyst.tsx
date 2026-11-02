import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq, smoothstep } from '../animations/sequence'
import { createGlowTexture } from '../utils/proceduralTextures'

const PURPLE = new THREE.Color('#9b4dff')

/**
 * Port of the supplied Analyst v2 procedural character, adapted to the shared
 * R3F renderer. It keeps its sculptural hood, ragged spectral robe, articulated
 * hands and gathering particle effect while using the graveyard's timeline.
 */
export function ImportedAnalyst() {
  const root = useRef<THREE.Group>(null)
  const cloak = useRef<THREE.ShaderMaterial>(null)
  const hood = useRef<THREE.ShaderMaterial>(null)
  const glow = useRef<THREE.SpriteMaterial>(null)
  const light = useRef<THREE.PointLight>(null)
  const particles = useRef<THREE.Points>(null)
  const particleMaterial = useRef<THREE.PointsMaterial>(null)
  const ragGeometry = useMemo(() => new THREE.CylinderGeometry(0.82, 0.18, 2.72, 96, 48, true), [])
  const hoodGeometry = useMemo(() => new THREE.SphereGeometry(1, 48, 34), [])
  const particleGeometry = useMemo(() => {
    const positions = new Float32Array(520 * 3)
    for (let i = 0; i < 520; i += 1) {
      const a = i * 2.39996
      const r = 0.18 + (i % 37) * 0.04
      positions[i * 3] = Math.cos(a) * r
      positions[i * 3 + 1] = (i % 54) * 0.052
      positions[i * 3 + 2] = Math.sin(a) * r
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return geometry
  }, [])
  const clothVertex = /* glsl */`
    uniform float uTime;
    varying float vHeight;
    varying vec3 vNormal;
    void main() {
      vec3 p = position;
      float lower = smoothstep(0.55, -1.35, p.y);
      p.x += sin(p.y * 7. + uTime * 1.45 + atan(p.z, p.x) * 5.) * .12 * lower;
      p.z += cos(p.y * 6. - uTime * 1.15 + atan(p.z, p.x) * 7.) * .15 * lower;
      p.y += sin(atan(p.z, p.x) * 12. + uTime * 1.8) * .1 * lower;
      vHeight = lower;
      vNormal = normalMatrix * normal;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
    }
  `
  const clothFragment = /* glsl */`
    uniform float uAppear;
    uniform float uTime;
    varying float vHeight;
    varying vec3 vNormal;
    void main() {
      float threads = .55 + .45 * sin(vHeight * 35. + uTime * 2. + gl_FragCoord.x * .045);
      float rim = pow(1. - abs(normalize(vNormal).z), 2.2);
      vec3 purple = vec3(.54, .19, .96);
      vec3 c = vec3(.014, .008, .027) + purple * (rim * .7 + threads * vHeight * .16);
      gl_FragColor = vec4(c, uAppear * (.7 + rim * .24));
    }
  `
  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uAppear: { value: 0 } },
    vertexShader: clothVertex, fragmentShader: clothFragment, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }), [])
  const hoodMaterial = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uAppear: { value: 0 } },
    vertexShader: clothVertex,
    fragmentShader: /* glsl */`
      uniform float uAppear; varying vec3 vNormal;
      void main(){ float rim=pow(1.-abs(normalize(vNormal).z),2.); gl_FragColor=vec4(vec3(.008,.004,.016)+vec3(.38,.1,.7)*rim*.5,uAppear*.92); }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }), [])
  const veinCurves = useMemo(() => [-1, 1].map((side) => new THREE.CatmullRomCurve3([
    new THREE.Vector3(side * .36, .48, .66), new THREE.Vector3(side * .18, 1.05, .73), new THREE.Vector3(side * .32, 1.58, .61), new THREE.Vector3(side * .09, 2.04, .48),
  ])), [])
  const ribbons = useMemo(() => [-1, 1].map((side) => new THREE.CatmullRomCurve3([
    new THREE.Vector3(side * .35, 1.58, 0), new THREE.Vector3(side * 1.16, 1.15, -.2), new THREE.Vector3(side * 1.45, .38, .08), new THREE.Vector3(side * 1.05, -.54, -.12),
  ])), [])

  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    const progress = seq.exploration.storyProgress
    const appear = smoothstep(0.015, 0.17, progress)
    if (root.current) {
      root.current.visible = appear > 0.003
      root.current.position.set(-2.85, .5 + appear * .17 + Math.sin(t * 1.08) * .075, -80.5)
      root.current.rotation.set(.04, .22 + Math.sin(t * .35) * .055, Math.sin(t * .7) * .018)
      root.current.scale.setScalar(.82 + appear * .22)
    }
    material.uniforms.uTime.value = t
    material.uniforms.uAppear.value = appear
    hoodMaterial.uniforms.uTime.value = t
    hoodMaterial.uniforms.uAppear.value = appear
    if (glow.current) glow.current.opacity = appear * (.25 + Math.sin(t * 2.4) * .04)
    if (light.current) light.current.intensity = appear * .95
    if (particles.current) { particles.current.rotation.y = -t * .38; particles.current.position.y = Math.sin(t * 1.4) * .08 }
    if (particleMaterial.current) particleMaterial.current.opacity = appear * (.54 + Math.sin(t * 3.6) * .1)
  })

  return <group ref={root} visible={false}>
    <sprite position={[0, 1.4, -.4]} scale={[5.5, 6.8, 1]}><spriteMaterial ref={glow} map={createGlowTexture(192)} color={PURPLE} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} /></sprite>
    <points ref={particles} geometry={particleGeometry}><pointsMaterial ref={particleMaterial} color="#c18aff" size={.06} transparent opacity={0} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} /></points>
    <mesh geometry={ragGeometry} material={material} position={[0, 1.32, 0]} />
    <mesh geometry={hoodGeometry} material={hoodMaterial} position={[0, 2.5, .02]} scale={[.54, .68, .52]} />
    <mesh position={[0, 2.38, .49]} scale={[.3, .42, .1]}><sphereGeometry args={[1, 20, 14]} /><meshBasicMaterial color="#000001" /></mesh>
    {[-1, 1].map((side) => <group key={side} position={[side * .62, 1.92, 0]} rotation={[.14, 0, -side * .88]}>
      <mesh position={[side * .48, -.06, 0]} scale={[.16, .84, .19]}><capsuleGeometry args={[.5, 1, 6, 10]} /><meshStandardMaterial color="#10091b" emissive="#4a1876" emissiveIntensity={.56} transparent opacity={.82} roughness={.46} depthWrite={false} /></mesh>
      <mesh position={[side * .9, -.72, .04]} scale={[.15, .27, .12]}><sphereGeometry args={[1, 14, 10]} /><meshStandardMaterial color="#160d25" emissive="#9147d9" emissiveIntensity={.8} transparent opacity={.92} roughness={.34} depthWrite={false} /></mesh>
    </group>)}
    {veinCurves.map((curve, index) => <mesh key={`vein-${index}`}><tubeGeometry args={[curve, 28, .024, 5, false]} /><meshBasicMaterial color="#bd76ff" transparent opacity={.78} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} /></mesh>)}
    {ribbons.map((curve, index) => <mesh key={`ribbon-${index}`}><tubeGeometry args={[curve, 32, .052, 6, false]} /><meshBasicMaterial color="#6930ad" transparent opacity={.6} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} /></mesh>)}
    <pointLight ref={light} position={[0, 1.5, .5]} color="#9b4dff" intensity={0} distance={15} decay={2} />
  </group>
}
