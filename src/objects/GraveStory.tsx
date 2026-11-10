import { useGLTF } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq, smoothstep } from '../animations/sequence'
import { createFogTexture, createGlowTexture, createStoneTextures } from '../utils/proceduralTextures'
import { playMainGraveRumble } from '../audio/audioManager'
import { RitualAtmosphere } from './RitualAtmosphere'
import { SoulMagic } from './SoulMagic'
import { GraveInscription } from './GraveInscription'
import { AnalystCharacter, FixerCharacter, TesterCharacter } from './SpectreCharacters'

const GRAVE = new THREE.Vector3(0, 0, -83)

function Candle({ position }: { position: [number, number, number] }) {
  const flame = useRef<THREE.Mesh>(null)
  const light = useRef<THREE.PointLight>(null)
  const glow = useRef<THREE.SpriteMaterial>(null)
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    const found = seq.exploration.nearMain
    const ignition = seq.exploration.storyStarted ? smoothstep(0.01 + (position[0] + 2) * 0.008, 0.05 + (position[0] + 2) * 0.008, seq.exploration.storyProgress) : 0
    const quiet = seq.ending.outcome === 'failure' ? 1 - smoothstep(0.1, 0.55, seq.ending.progress) * 0.8 : 1
    const strength = (0.35 + ignition * 0.65) * quiet
    const flicker = 0.82 + Math.sin(t * 19) * 0.09 + Math.sin(t * 31) * 0.045
    if (flame.current) {
      flame.current.scale.set(1 + Math.sin(t * 23) * 0.09, flicker * strength, 1 + Math.cos(t * 17) * 0.08)
      flame.current.rotation.z = Math.sin(t * 13) * 0.08
    }
    if (light.current) light.current.intensity = (0.38 + found * 2.45) * flicker * strength
    if (glow.current) glow.current.opacity = (0.08 + found * 0.36) * flicker * strength
  })
  return <group position={position}>
    <mesh castShadow><cylinderGeometry args={[0.12, 0.15, 0.72, 12]} /><meshStandardMaterial color="#b8a88a" roughness={0.92} /></mesh>
    <mesh ref={flame} position={[0, 0.48, 0]}><sphereGeometry args={[0.105, 12, 12]} /><meshBasicMaterial color="#ffd18a" toneMapped={false} /></mesh>
    <sprite position={[0, 0.48, 0]} scale={[2.6, 2.6, 1]}><spriteMaterial ref={glow} map={createGlowTexture(128)} color="#ff9e48" transparent opacity={0.3} depthWrite={false} blending={THREE.AdditiveBlending} /></sprite>
    <pointLight ref={light} color="#ffad62" intensity={2.4} distance={11} decay={2} />
  </group>
}

function MainStone() {
  const crackMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: '#101518', emissive: '#83ffba', roughness: 1, emissiveIntensity: 0 }), [])
  useEffect(() => () => crackMaterial.dispose(), [crackMaterial])
  const materials = useMemo(() => createStoneTextures(512), [])
  const material = useMemo(() => new THREE.MeshStandardMaterial({ map: materials.map, bumpMap: materials.bumpMap, bumpScale: 0.65, roughness: 0.95, color: '#b9c2c8' }), [materials])
  const stoneColor = useMemo(() => new THREE.Color('#b9c2c8'), [])
  const cracks = useMemo(() => {
    const paths = [
      [[-0.2, 3.9, 0.65], [-0.05, 3.35, 0.67], [-0.35, 2.95, 0.68], [-0.1, 2.45, 0.68]],
      [[0.65, 3.2, 0.67], [0.38, 2.9, 0.69], [0.55, 2.35, 0.69], [0.25, 1.9, 0.68]],
      [[-0.85, 2.3, 0.66], [-0.5, 2.05, 0.68], [-0.65, 1.65, 0.68]],
    ]
    return paths.map((path) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(path.map((p) => new THREE.Vector3(...p as [number, number, number]))), 22, 0.025, 5, false))
  }, [])
  const moss = useMemo(() => Array.from({ length: 16 }, (_, i) => ({
    x: Math.sin(i * 17.2) * 0.82,
    y: 0.45 + ((i * 31) % 37) / 10,
    z: 0.54 + Math.sin(i * 3.1) * 0.07,
    s: 0.12 + (i % 4) * 0.07,
  })), [])
  const reveal = useRef<THREE.Group>(null)
  const slab = useRef<THREE.Group>(null)
  const halo = useRef<THREE.SpriteMaterial>(null)
  const burialLight = useRef<THREE.PointLight>(null)
  const rumbleArmed = useRef(true)
  useFrame(({ clock }) => {
    const found = seq.exploration.nearMain
    if (found > 0.58 && rumbleArmed.current) {
      rumbleArmed.current = false
      playMainGraveRumble()
    }
    if (found < 0.16) rumbleArmed.current = true
    const success = seq.ending.outcome === 'success'
    crackMaterial.emissiveIntensity = success ? smoothstep(0.45, 0.8, seq.ending.progress) * 2.2 : 0
    const opening = success ? smoothstep(0.7, 0.86, seq.ending.progress) : 0
    const verifiedShake = success ? smoothstep(0.44, 0.53, seq.ending.progress) * (1 - smoothstep(0.68, 0.73, seq.ending.progress)) : 0
    const attemptShake = smoothstep(0.72, 0.91, seq.exploration.storyProgress) * (1 - smoothstep(0.985, 1, seq.exploration.storyProgress)) * 0.28
    const shake = Math.max(verifiedShake, attemptShake)
    if (reveal.current) {
      // A distant silhouette and its cold beacon give the visitor a landmark
      // before the clearing's fog parts near the grave.
      reveal.current.visible = true
      reveal.current.scale.setScalar(1)
      reveal.current.position.x = Math.sin(clock.elapsedTime * 39) * shake * 0.09
      reveal.current.rotation.z = Math.sin(clock.elapsedTime * 32) * shake * 0.018
    }
    if (slab.current) {
      slab.current.rotation.x = -opening * 1.15
      slab.current.position.y = 0.43 + opening * 0.28
    }
    material.color.copy(stoneColor).multiplyScalar(0.12 + found * 0.88)
    material.emissive.setRGB(0.009 + found * 0.028, 0.012 + found * 0.035, 0.014 + found * 0.032)
    if (halo.current) halo.current.opacity = 0.045 + found * (0.13 + Math.sin(clock.elapsedTime * 2.1) * 0.025)
    if (burialLight.current) burialLight.current.intensity = 0.12 + found * (0.45 + Math.sin(clock.elapsedTime * 2.4) * 0.08)
  })
  return <group ref={reveal} position={[GRAVE.x, 0, GRAVE.z]}>
    {/* Unearthed burial mound, stone edging and a two-step plinth anchor the tall headstone to a full grave. */}
    <mesh position={[0, 0.11, 2.05]} scale={[2.05, 0.36, 2.48]} castShadow receiveShadow>
      <sphereGeometry args={[1, 28, 16]} /><meshStandardMaterial color="#272019" roughness={1} />
    </mesh>
    {[-2.05, 2.05].map((x) => <mesh key={`grave-curb-${x}`} position={[x, 0.14, 1.55]} castShadow receiveShadow>
      <boxGeometry args={[0.2, 0.28, 4.9]} /><meshStandardMaterial color="#353431" roughness={0.98} />
    </mesh>)}
    {[-1.9, 4.0].map((z) => <mesh key={`grave-end-${z}`} position={[0, 0.14, z]} castShadow receiveShadow>
      <boxGeometry args={[4.2, 0.28, 0.22]} /><meshStandardMaterial color="#393733" roughness={0.98} />
    </mesh>)}
    <mesh position={[0, 0.16, -0.85]} castShadow receiveShadow><boxGeometry args={[3.55, 0.32, 1.55]} /><meshStandardMaterial color="#35383a" roughness={0.96} /></mesh>
    <mesh position={[0, 0.37, -0.85]} castShadow receiveShadow><boxGeometry args={[3.18, 0.12, 1.28]} /><meshStandardMaterial color="#5a5a54" roughness={0.95} /></mesh>
    {/* The slab, cracks, moss and engraving share one hinge and meet the plinth. */}
    <group ref={slab} position={[0, 0.43, -0.85]}>
      <mesh castShadow receiveShadow material={material}>
        <extrudeGeometry args={[(() => { const s = new THREE.Shape(); s.moveTo(-1.28, 0); s.lineTo(-1.42, 2.75); s.lineTo(-1.18, 3.15); s.lineTo(-0.78, 3.62); s.lineTo(-0.42, 3.48); s.lineTo(0.1, 4.2); s.lineTo(0.48, 3.58); s.lineTo(0.94, 3.72); s.lineTo(1.38, 3.15); s.lineTo(1.3, 0); s.closePath(); return s })(), { depth: 0.52, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: 0.09, bevelThickness: 0.1 }]} />
      </mesh>
      {cracks.map((geometry, i) => <mesh key={`crack-${i}`} geometry={geometry} material={crackMaterial} />)}
      {moss.map((m, i) => <mesh key={`moss-${i}`} position={[m.x, m.y, m.z]} scale={[m.s * 1.8, m.s, 0.05]} rotation={[0, 0, Math.sin(i) * 0.35]}><sphereGeometry args={[1, 9, 7]} /><meshStandardMaterial color={i % 3 ? '#344b35' : '#536448'} roughness={1} /></mesh>)}
      {/* Carved gothic crown: cross, rose window and pointed arch detail. */}
      <group position={[0, 3.42, 0.64]}>
        <mesh position={[0, 0.48, 0]}><boxGeometry args={[0.11, 0.96, 0.08]} /><meshStandardMaterial color="#596367" roughness={0.9} /></mesh>
        <mesh position={[0, 0.62, 0.01]}><boxGeometry args={[0.58, 0.1, 0.08]} /><meshStandardMaterial color="#596367" roughness={0.9} /></mesh>
        <mesh position={[0, -0.2, 0.015]}><torusGeometry args={[0.31, 0.045, 8, 24]} /><meshStandardMaterial color="#626c6d" roughness={0.92} /></mesh>
        {[0, Math.PI / 2].map((rotation) => <mesh key={rotation} position={[0, -0.2, 0.04]} rotation={[0, 0, rotation]}><boxGeometry args={[0.45, 0.035, 0.05]} /><meshStandardMaterial color="#596367" roughness={0.92} /></mesh>)}
      </group>
      <GraveInscription />
      <mesh position={[0, 0.46, 0.82]} rotation={[0, 0, Math.PI / 2]}><torusGeometry args={[0.2, 0.045, 7, 16]} /><meshStandardMaterial color="#242a2d" metalness={0.72} roughness={0.82} /></mesh>
      <mesh position={[0.32, 0.46, 0.82]} rotation={[0, 0, Math.PI / 2]}><torusGeometry args={[0.2, 0.045, 7, 16]} /><meshStandardMaterial color="#242a2d" metalness={0.72} roughness={0.82} /></mesh>
    </group>
    {[[-1.65, 0.48, 1.1], [-0.75, 0.48, 1.42], [0.25, 0.48, 1.32], [1.55, 0.48, 1.08], [2.0, 0.48, 0.28]].map((position, index) => <Candle key={index} position={position as [number, number, number]} />)}
    {/* Chipped fragments make the monument feel older than the surrounding plots. */}
    {[[-1.65, 0.36, -0.52, 0.34], [1.55, 0.26, -0.34, 0.26], [-1.48, 1.65, -0.52, 0.18], [1.42, 2.76, -0.48, 0.21]].map(([x, y, z, s], index) => <mesh key={`chip-${index}`} position={[x, y, z]} rotation={[index * 0.5, index * 0.7, index * 0.23]} scale={s} castShadow><tetrahedronGeometry args={[1, 1]} /><meshStandardMaterial color="#4c5354" roughness={1} /></mesh>)}
    <sprite position={[0, 0.32, 1.3]} scale={[13, 4.5, 1]}>
      <spriteMaterial ref={halo} map={createGlowTexture(192)} color="#b6d0c0" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
    </sprite>
    <pointLight ref={burialLight} position={[0, 2.4, 1.2]} color="#a9c5b6" intensity={0} distance={18} decay={2} />
  </group>
}

/** A dim vertical beacon is visible from the gate, then is swallowed by local fog until discovery. */
function FinalGraveBeacon() {
  const beam = useRef<THREE.SpriteMaterial>(null)
  const crown = useRef<THREE.SpriteMaterial>(null)
  useFrame(({ clock }) => {
    const found = seq.exploration.nearMain
    const pulse = 0.72 + Math.sin(clock.elapsedTime * 1.4) * 0.12
    const distant = 1 - smoothstep(0.1, 0.4, found)
    if (beam.current) beam.current.opacity = (0.34 * distant + 0.045) * pulse
    if (crown.current) crown.current.opacity = (0.52 * distant + 0.08) * pulse
  })
  return <group position={[GRAVE.x, 0, GRAVE.z]}>
    <sprite position={[0, 9.4, -0.8]} scale={[7.2, 28, 1]}>
      <spriteMaterial ref={beam} map={createGlowTexture(192)} color="#54bce9" transparent opacity={0} depthWrite={false} fog={false} />
    </sprite>
    <sprite position={[0, 5.6, -0.8]} scale={[10, 10, 1]}>
      <spriteMaterial ref={crown} map={createGlowTexture(128)} color="#74cef3" transparent opacity={0} depthWrite={false} fog={false} />
    </sprite>
  </group>
}

function GiantTree() {
  const { scene } = useGLTF('/models/dead-tree.glb')
  const tree = useMemo(() => {
    const clone = scene.clone(true)
    clone.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      materials.forEach((m) => {
        const mat = m as THREE.MeshStandardMaterial
        mat.color.multiplyScalar(0.68)
        mat.roughness = 1
      })
    })
    return clone
  }, [scene])
  useFrame(({ clock }) => {
    const wind = smoothstep(0.72, 0.9, seq.exploration.storyProgress) * (1 - smoothstep(0.35, 0.8, seq.ending.progress))
    tree.rotation.z = Math.sin(clock.elapsedTime * 0.7) * wind * 0.003
  })
  // Keep the full dead-tree silhouette in frame behind the main grave.
  return <primitive object={tree} position={[5.5, 12.1, -94]} scale={25} rotation={[0, 0.3, 0]} />
}

/** The Analyst is a distinct hooded entity: fog-born particles form its body, then its scan turns toward the grave. */
function Analyst() {
  const root = useRef<THREE.Group>(null)
  const cloak = useRef<THREE.MeshStandardMaterial>(null)
  const hood = useRef<THREE.MeshStandardMaterial>(null)
  const aura = useRef<THREE.SpriteMaterial>(null)
  const particles = useRef<THREE.Points>(null)
  const particleMaterial = useRef<THREE.PointsMaterial>(null)
  const light = useRef<THREE.PointLight>(null)
  const scan = useRef<THREE.Group>(null)
  const body = useMemo(() => new THREE.LatheGeometry([
    new THREE.Vector2(0.84, 0), new THREE.Vector2(0.76, 0.18), new THREE.Vector2(0.62, 0.6),
    new THREE.Vector2(0.5, 1.26), new THREE.Vector2(0.4, 1.82), new THREE.Vector2(0.29, 2.28),
    new THREE.Vector2(0.13, 2.54), new THREE.Vector2(0.02, 2.68),
  ], 36), [])
  const particleGeometry = useMemo(() => {
    const positions = new Float32Array(220 * 3)
    for (let i = 0; i < 220; i += 1) {
      const angle = i * 2.39996
      const radius = 0.25 + (i % 31) * 0.09
      positions[i * 3] = Math.cos(angle) * radius
      positions[i * 3 + 1] = (i % 43) * 0.095
      positions[i * 3 + 2] = Math.sin(angle) * radius
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return geometry
  }, [])
  const veins = useMemo(() => [
    new THREE.CatmullRomCurve3([new THREE.Vector3(-0.36, 0.72, 0.48), new THREE.Vector3(-0.18, 1.24, 0.61), new THREE.Vector3(-0.24, 1.74, 0.52), new THREE.Vector3(-0.08, 2.16, 0.35)]),
    new THREE.CatmullRomCurve3([new THREE.Vector3(0.32, 0.68, 0.48), new THREE.Vector3(0.16, 1.12, 0.62), new THREE.Vector3(0.28, 1.58, 0.5), new THREE.Vector3(0.06, 2.1, 0.36)]),
  ], [])
  const ribbons = useMemo(() => [-1, 1].map((side) => new THREE.CatmullRomCurve3([
    new THREE.Vector3(side * 0.28, 1.78, 0), new THREE.Vector3(side * 1.1, 1.35, -0.2),
    new THREE.Vector3(side * 1.42, 0.58, 0.12), new THREE.Vector3(side * 1.1, -0.42, -0.08),
  ])), [])
  const vortex = useMemo(() => [
    new THREE.CatmullRomCurve3([new THREE.Vector3(-2.4, 0.6, 0.3), new THREE.Vector3(-1.1, 1.1, -0.5), new THREE.Vector3(0.4, 1.7, -0.7), new THREE.Vector3(1.9, 1.22, -0.15), new THREE.Vector3(2.35, 0.72, 0.42)]),
    new THREE.CatmullRomCurve3([new THREE.Vector3(2.2, 2.9, -0.15), new THREE.Vector3(0.95, 3.55, -0.55), new THREE.Vector3(-0.75, 3.28, -0.38), new THREE.Vector3(-2.12, 2.46, 0.05)]),
  ], [])

  useFrame(({ clock }) => {
    const story = seq.exploration.storyProgress
    const materialize = smoothstep(0.015, 0.17, story)
    const scanPower = smoothstep(0.16, 0.23, story) * (1 - smoothstep(0.72, 0.8, story))
    const t = clock.elapsedTime
    if (root.current) {
      root.current.visible = materialize > 0.004
      root.current.position.set(-2.85, 0.48 + materialize * 0.18 + Math.sin(t * 0.85) * 0.1, -80.5)
      root.current.rotation.y = 0.18 + Math.sin(t * 0.25) * 0.06
      root.current.scale.setScalar(0.84 + materialize * 0.16)
    }
    if (cloak.current) cloak.current.opacity = materialize * 0.64
    if (hood.current) hood.current.opacity = materialize * 0.9
    if (aura.current) aura.current.opacity = materialize * (0.22 + Math.sin(t * 2.4) * 0.04)
    if (particles.current) {
      particles.current.rotation.y = t * 0.34
      particles.current.scale.setScalar(1.8 - materialize * 0.74)
      particles.current.position.y = 0.2 + Math.sin(t * 1.2) * 0.08
    }
    if (particleMaterial.current) particleMaterial.current.opacity = materialize * (0.42 + Math.sin(t * 3.1) * 0.08)
    if (light.current) light.current.intensity = materialize * (0.42 + scanPower * 1.25)
    if (scan.current) {
      scan.current.visible = scanPower > 0.005
      scan.current.rotation.z = t * 0.52
      scan.current.rotation.y = t * 0.26
      scan.current.scale.setScalar(0.78 + scanPower * 0.38)
    }
  })

  return <>
    <group ref={root} visible={false}>
      <sprite position={[0, 1.55, -0.28]} scale={[5.2, 6.4, 1]}><spriteMaterial ref={aura} map={createGlowTexture(192)} color="#7b3bcb" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} /></sprite>
      <points ref={particles} geometry={particleGeometry}><pointsMaterial ref={particleMaterial} color="#b875ff" size={0.065} transparent opacity={0} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} /></points>
      <mesh geometry={body}><meshStandardMaterial ref={cloak} color="#0b0911" emissive="#31114f" emissiveIntensity={0.7} transparent opacity={0} roughness={0.42} metalness={0.04} depthWrite={false} side={THREE.DoubleSide} /></mesh>
      {/* Broad draped shoulders and a deep hood give the character its recognisable wraith silhouette. */}
      <mesh position={[0, 2.04, -0.01]} scale={[1.08, 0.35, 0.62]}><sphereGeometry args={[1, 28, 16]} /><meshStandardMaterial color="#100c18" emissive="#2c1048" emissiveIntensity={0.34} transparent opacity={0.84} roughness={0.68} depthWrite={false} /></mesh>
      <mesh position={[0, 2.43, 0.02]} scale={[0.57, 0.68, 0.5]}><sphereGeometry args={[1, 28, 20]} /><meshStandardMaterial ref={hood} color="#05050a" emissive="#2d1048" emissiveIntensity={0.38} transparent opacity={0} roughness={0.74} depthWrite={false} /></mesh>
      <mesh position={[0, 2.33, 0.43]} scale={[0.32, 0.4, 0.1]}><sphereGeometry args={[1, 20, 14]} /><meshBasicMaterial color="#000000" transparent opacity={0.98} depthWrite={false} /></mesh>
      {[-1, 1].map((side) => <group key={`analyst-arm-${side}`} position={[side * 0.78, 1.88, 0.05]} rotation={[0.16, 0, -side * 0.88]}>
        <mesh position={[side * 0.45, -0.1, 0]} scale={[0.17, 0.86, 0.2]}><capsuleGeometry args={[0.5, 1, 6, 10]} /><meshStandardMaterial color="#100b19" emissive="#3d155f" emissiveIntensity={0.52} transparent opacity={0.78} roughness={0.45} depthWrite={false} /></mesh>
        <mesh position={[side * 0.86, -0.72, 0.04]} scale={[0.17, 0.28, 0.13]}><sphereGeometry args={[1, 14, 10]} /><meshStandardMaterial color="#191024" emissive="#7b35b6" emissiveIntensity={0.72} transparent opacity={0.86} roughness={0.4} depthWrite={false} /></mesh>
        {[-0.1, 0.08, 0.24].map((offset) => <mesh key={offset} position={[side * (0.9 + offset), -0.89, 0.06]} rotation={[0.15, 0, side * 0.45]} scale={[0.025, 0.23, 0.025]}><capsuleGeometry args={[0.5, 1, 4, 6]} /><meshBasicMaterial color="#b96cff" transparent opacity={0.7} blending={THREE.AdditiveBlending} depthWrite={false} /></mesh>)}
      </group>)}
      {veins.map((curve, index) => <mesh key={`analyst-vein-${index}`}><tubeGeometry args={[curve, 28, 0.023, 5, false]} /><meshBasicMaterial color="#ac65ff" transparent opacity={0.72} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} /></mesh>)}
      {ribbons.map((curve, index) => <mesh key={`analyst-ribbon-${index}`}><tubeGeometry args={[curve, 34, 0.048, 6, false]} /><meshBasicMaterial color="#6d32b8" transparent opacity={0.52} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} /></mesh>)}
      {[-0.48, 0, 0.48].map((x, index) => <mesh key={`torn-tail-${index}`} position={[x, 0.36 - index * 0.08, -0.02]} rotation={[0.1, 0, (index - 1) * 0.18]} scale={[0.26, 1.15 + index * 0.16, 0.05]}><coneGeometry args={[1, 1, 4]} /><meshStandardMaterial color="#130d1d" emissive="#32114f" emissiveIntensity={0.42} transparent opacity={0.6} roughness={0.6} depthWrite={false} side={THREE.DoubleSide} /></mesh>)}
      <pointLight ref={light} position={[0, 1.4, 0.5]} color="#9d55e8" intensity={0} distance={14} decay={2} />
    </group>
    <group ref={scan} position={[GRAVE.x, 2.45, GRAVE.z + 0.42]} visible={false}>
      {[0, 1, 2].map((index) => <mesh key={index} rotation={[Math.PI / 2 + index * 0.12, 0, index * 0.45]}><torusGeometry args={[0.92 + index * 0.42, 0.018, 6, 72]} /><meshBasicMaterial color="#a865ff" transparent opacity={0.56 - index * 0.09} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} /></mesh>)}
      {vortex.map((curve, index) => <mesh key={`vortex-${index}`}><tubeGeometry args={[curve, 42, 0.075, 7, false]} /><meshBasicMaterial color="#8d42ef" transparent opacity={0.76} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} /></mesh>)}
    </group>
  </>
}

/** The Fixer is denser and more physical than the Analyst: a crimson repair-wraith rooted in sparks and fractured energy. */
function Fixer() {
  const root = useRef<THREE.Group>(null)
  const bodyMaterial = useRef<THREE.MeshStandardMaterial>(null)
  const hoodMaterial = useRef<THREE.MeshStandardMaterial>(null)
  const emberMaterial = useRef<THREE.PointsMaterial>(null)
  const light = useRef<THREE.PointLight>(null)
  const core = useRef<THREE.MeshBasicMaterial>(null)
  const body = useMemo(() => new THREE.LatheGeometry([
    new THREE.Vector2(1.02, 0), new THREE.Vector2(0.88, 0.24), new THREE.Vector2(0.7, 0.72),
    new THREE.Vector2(0.52, 1.34), new THREE.Vector2(0.45, 1.86), new THREE.Vector2(0.31, 2.27),
    new THREE.Vector2(0.13, 2.56), new THREE.Vector2(0.02, 2.72),
  ], 36), [])
  const embers = useMemo(() => {
    const positions = new Float32Array(260 * 3)
    for (let i = 0; i < 260; i += 1) {
      const a = i * 2.399
      const r = 0.3 + (i % 37) * 0.075
      positions[i * 3] = Math.cos(a) * r
      positions[i * 3 + 1] = (i % 52) * 0.07
      positions[i * 3 + 2] = Math.sin(a) * r
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return geometry
  }, [])
  const rootTrails = useMemo(() => Array.from({ length: 8 }, (_, i) => {
    const side = i % 2 ? 1 : -1
    const spread = 0.55 + (i % 4) * 0.25
    return new THREE.CatmullRomCurve3([
      new THREE.Vector3(side * (0.2 + (i % 3) * 0.12), 0.86, 0), new THREE.Vector3(side * spread, 0.35, -0.1),
      new THREE.Vector3(side * (spread + 0.45), -0.22, 0.18), new THREE.Vector3(side * (spread + 0.8), -0.52, -0.18),
    ])
  }), [])
  const armTrails = useMemo(() => [-1, 1].map((side) => new THREE.CatmullRomCurve3([
    new THREE.Vector3(side * 0.55, 1.86, 0), new THREE.Vector3(side * 1.45, 1.45, 0.02),
    new THREE.Vector3(side * 2.05, 0.92, -0.1), new THREE.Vector3(side * 2.42, 0.46, 0.08),
  ])), [])
  useFrame(({ clock }) => {
    const story = seq.exploration.storyProgress
    const arrival = smoothstep(0.24, 0.42, story)
    const t = clock.elapsedTime
    if (root.current) {
      root.current.visible = arrival > 0.004
      root.current.position.set(2.9, 0.42 + arrival * 0.16 + Math.sin(t * 0.92 + 1.2) * 0.075, -80.15)
      root.current.rotation.y = -0.24 + Math.sin(t * 0.3) * 0.055
      root.current.scale.setScalar(0.78 + arrival * 0.22)
    }
    if (bodyMaterial.current) bodyMaterial.current.opacity = arrival * 0.72
    if (hoodMaterial.current) hoodMaterial.current.opacity = arrival * 0.92
    if (emberMaterial.current) emberMaterial.current.opacity = arrival * (0.55 + Math.sin(t * 4.6) * 0.12)
    if (core.current) core.current.opacity = arrival * (0.75 + Math.sin(t * 3.6) * 0.12)
    if (light.current) light.current.intensity = arrival * (1.4 + Math.sin(t * 3.5) * 0.2)
  })
  return <group ref={root} visible={false}>
    <points geometry={embers} position={[0, -0.25, 0]}><pointsMaterial ref={emberMaterial} color="#ff5548" size={0.085} transparent opacity={0} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} /></points>
    <sprite position={[0, 1.35, -0.3]} scale={[5.4, 6.6, 1]}><spriteMaterial map={createGlowTexture(192)} color="#9c1f23" transparent opacity={0.18} depthWrite={false} blending={THREE.AdditiveBlending} /></sprite>
    <mesh geometry={body}><meshStandardMaterial ref={bodyMaterial} color="#120809" emissive="#5b1719" emissiveIntensity={0.74} transparent opacity={0} roughness={0.4} metalness={0.08} depthWrite={false} side={THREE.DoubleSide} /></mesh>
    <mesh position={[0, 2.43, 0.02]} scale={[0.6, 0.7, 0.53]}><sphereGeometry args={[1, 28, 20]} /><meshStandardMaterial ref={hoodMaterial} color="#080708" emissive="#4f1416" emissiveIntensity={0.48} transparent opacity={0} roughness={0.72} depthWrite={false} /></mesh>
    <mesh position={[0, 2.31, 0.43]} scale={[0.33, 0.4, 0.1]}><sphereGeometry args={[1, 20, 14]} /><meshBasicMaterial color="#010000" transparent opacity={0.98} depthWrite={false} /></mesh>
    {[-0.13, 0.13].map((x) => <mesh key={x} position={[x, 2.38, 0.51]} scale={[0.05, 0.035, 0.02]}><sphereGeometry args={[1, 12, 8]} /><meshBasicMaterial color="#ff342d" toneMapped={false} /></mesh>)}
    <mesh position={[0, 1.57, 0.49]} scale={[0.17, 0.24, 0.06]}><sphereGeometry args={[1, 16, 12]} /><meshBasicMaterial ref={core} color="#ff5b45" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} /></mesh>
    {[-1, 1].map((side) => <group key={`fixer-arm-${side}`} position={[side * 0.78, 1.9, 0]} rotation={[0.12, 0, -side * 0.88]}>
      <mesh position={[side * 0.5, -0.08, 0]} scale={[0.18, 0.9, 0.21]}><capsuleGeometry args={[0.5, 1, 6, 10]} /><meshStandardMaterial color="#190b0d" emissive="#722025" emissiveIntensity={0.55} transparent opacity={0.8} roughness={0.48} depthWrite={false} /></mesh>
      <mesh position={[side * 0.94, -0.75, 0.03]} scale={[0.17, 0.3, 0.13]}><sphereGeometry args={[1, 14, 10]} /><meshStandardMaterial color="#251014" emissive="#bc302c" emissiveIntensity={0.8} transparent opacity={0.9} roughness={0.35} depthWrite={false} /></mesh>
    </group>)}
    {rootTrails.map((curve, index) => <mesh key={`fixer-root-${index}`}><tubeGeometry args={[curve, 28, 0.035 + (index % 3) * 0.012, 5, false]} /><meshBasicMaterial color={index % 2 ? '#6c1b21' : '#b42b2a'} transparent opacity={0.52} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} /></mesh>)}
    {armTrails.map((curve, index) => <mesh key={`fixer-arm-trail-${index}`}><tubeGeometry args={[curve, 32, 0.046, 6, false]} /><meshBasicMaterial color="#d13931" transparent opacity={0.62} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} /></mesh>)}
    <pointLight ref={light} position={[0, 1.5, 0.5]} color="#e63b35" intensity={0} distance={16} decay={2} />
  </group>
}

interface AgentConfig { name: string; color: string; x: number; start: number; role: number }
const agents: AgentConfig[] = [
  { name: 'TESTER', color: '#61f29b', x: 0, start: 0.48, role: 2 },
]

function Apparition({ config }: { config: AgentConfig }) {
  const root = useRef<THREE.Group>(null)
  const veil = useRef<THREE.MeshStandardMaterial>(null)
  const core = useRef<THREE.Mesh>(null)
  const aura = useRef<THREE.SpriteMaterial>(null)
  const particles = useRef<THREE.Points>(null)
  const light = useRef<THREE.PointLight>(null)
  const color = useMemo(() => new THREE.Color(config.color), [config.color])
  const particleGeometry = useMemo(() => {
    const p = new Float32Array(72 * 3)
    for (let i = 0; i < 72; i++) {
      const angle = i * 2.399
      const radius = 0.5 + (i % 13) * 0.1
      p[i * 3] = Math.cos(angle) * radius
      p[i * 3 + 1] = (i % 24) * 0.15
      p[i * 3 + 2] = Math.sin(angle) * radius * 0.45
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(p, 3))
    return g
  }, [])
  const tornHem = useMemo(() => {
    const vertices: number[] = []
    const indices: number[] = []
    const count = 24
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2
      const b = ((i + 1) / count) * Math.PI * 2
      const middle = (a + b) * 0.5
      const tipRadius = 0.7 + Math.sin(i * 2.17) * 0.1
      const tipHeight = -0.05 + Math.cos(i * 3.61) * 0.14
      vertices.push(Math.cos(a) * 0.55, 0.2, Math.sin(a) * 0.55)
      vertices.push(Math.cos(b) * 0.55, 0.2, Math.sin(b) * 0.55)
      vertices.push(Math.cos(middle) * tipRadius, tipHeight, Math.sin(middle) * tipRadius)
      const base = i * 3
      indices.push(base, base + 1, base + 2)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    return geometry
  }, [])
  const wings = useMemo(() => {
    const makeWing = (side: number) => Array.from({ length: 9 }, (_, index) => {
      const spread = 0.9 + index * 0.23
      const lift = 1.72 + index * 0.11
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 0.12, 1.82, -0.08),
        new THREE.Vector3(side * spread * 0.44, lift + 0.42, -0.14 - index * 0.018),
        new THREE.Vector3(side * spread, lift + 0.12 - index * 0.07, -0.22),
        new THREE.Vector3(side * (spread + 0.2), 0.92 - index * 0.12, -0.1),
      ]), 20, 0.012 + (index % 3) * 0.004, 4, false)
    })
    return [-1, 1].flatMap((side) => makeWing(side))
  }, [])
  const wingMembrane = useMemo(() => {
    const shape = new THREE.Shape()
    shape.moveTo(0.08, 1.75)
    shape.bezierCurveTo(0.82, 2.72, 2.0, 3.0, 3.12, 2.62)
    shape.bezierCurveTo(2.66, 2.12, 2.46, 1.45, 2.78, 0.85)
    shape.bezierCurveTo(1.92, 1.18, 1.4, 0.52, 0.66, 0.68)
    shape.bezierCurveTo(0.42, 1.14, 0.25, 1.43, 0.08, 1.75)
    return new THREE.ShapeGeometry(shape, 18)
  }, [])
  const body = useMemo(() => new THREE.LatheGeometry([
    new THREE.Vector2(0.76, 0), new THREE.Vector2(0.7, 0.18), new THREE.Vector2(0.58, 0.58),
    new THREE.Vector2(0.46, 1.05), new THREE.Vector2(0.39, 1.52), new THREE.Vector2(0.34, 1.9),
    new THREE.Vector2(0.24, 2.16), new THREE.Vector2(0.29, 2.35), new THREE.Vector2(0.16, 2.55), new THREE.Vector2(0.02, 2.7),
  ], 32), [])
  const energyVeins = useMemo(() => [
    new THREE.CatmullRomCurve3([new THREE.Vector3(-0.3, 0.9, 0.4), new THREE.Vector3(-0.18, 1.24, 0.52), new THREE.Vector3(-0.05, 1.58, 0.58), new THREE.Vector3(-0.11, 1.95, 0.46)]),
    new THREE.CatmullRomCurve3([new THREE.Vector3(0.3, 0.82, 0.4), new THREE.Vector3(0.12, 1.18, 0.54), new THREE.Vector3(0.04, 1.53, 0.59), new THREE.Vector3(0.22, 1.9, 0.46)]),
  ], [])
  useFrame(({ clock }) => {
    const story = seq.exploration.storyProgress
    const arrival = smoothstep(config.start, config.start + 0.14, story)
    const endingReveal = seq.ending.started ? 1 - smoothstep(0.91, 0.99, seq.ending.progress) : 1
    const k = arrival * endingReveal
    const t = clock.elapsedTime
    const launchX = config.x + (config.role === 0 ? -6 : config.role === 1 ? 6 : 0)
    if (root.current) {
      root.current.visible = k > 0.005
      root.current.position.set(GRAVE.x + THREE.MathUtils.lerp(launchX, config.x, arrival), 0.55 + (1 - arrival) * 5.2 + Math.sin(t * 0.8 + config.role) * 0.08 + seq.ending.gather * 0.35, THREE.MathUtils.lerp(GRAVE.z + 9, GRAVE.z + 2.5, arrival))
      root.current.scale.setScalar(0.9 + k * 0.1)
    }
    if (veil.current) veil.current.opacity = 0.46 * k
    if (aura.current) aura.current.opacity = 0.76 * k * (0.88 + Math.sin(t * 2.1 + config.role) * 0.12)
    if (core.current) core.current.scale.y = 1 + Math.sin(t * 1.8 + config.role) * 0.06
    if (particles.current) {
      particles.current.rotation.y = t * (config.role % 2 ? -0.2 : 0.2)
      particles.current.position.y = -0.6 + Math.sin(t * 1.3 + config.role) * 0.16
    }
    if (light.current) light.current.intensity = 2.2 * k
  })
  return <group ref={root} visible={false}>
    <sprite position={[0, 1.4, -0.38]} scale={[5, 6.5, 1]}><spriteMaterial ref={aura} map={createGlowTexture(128)} color={color} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} /></sprite>
    <mesh geometry={body} position={[0, -0.1, 0]}>
      <meshStandardMaterial ref={veil} color={color} emissive={color} emissiveIntensity={1.25} transparent opacity={0} roughness={0.22} metalness={0.05} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
    <mesh geometry={tornHem} position={[0, -0.08, 0]}>
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.72} transparent opacity={0.3} roughness={0.3} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
    {/* A hooded, tapered silhouette gives each apparition a human scale beneath its energy veil. */}
    <mesh position={[0, 2.36, 0]} scale={[0.3, 0.4, 0.28]}>
      <sphereGeometry args={[1, 18, 14]} />
      <meshStandardMaterial color="#080a10" emissive={color} emissiveIntensity={0.35} transparent opacity={0.72} roughness={0.6} depthWrite={false} />
    </mesh>
    <mesh position={[0, 2.32, 0.2]} scale={[0.19, 0.25, 0.11]}>
      <sphereGeometry args={[1, 14, 10]} />
      <meshBasicMaterial color="#010204" transparent opacity={0.92} depthWrite={false} />
    </mesh>
    {[-1, 1].map((side) => <mesh key={`arm-${side}`} position={[side * 0.55, 1.27, 0]} rotation={[0, 0, -side * 0.31]} scale={[0.15, 0.72, 0.16]}>
      <capsuleGeometry args={[0.5, 1, 5, 8]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} transparent opacity={0.3} roughness={0.3} depthWrite={false} />
    </mesh>)}
    {energyVeins.map((curve, i) => <mesh key={`vein-${i}`}><tubeGeometry args={[curve, 28, 0.018, 5, false]} /><meshBasicMaterial color={color} transparent opacity={0.7} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} /></mesh>)}
    {wings.map((geometry, i) => <mesh key={`wing-${i}`} geometry={geometry}>
      <meshBasicMaterial color={color} transparent opacity={0.66} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
    </mesh>)}
    {[-1, 1].map((side) => <mesh key={`membrane-${side}`} geometry={wingMembrane} position={[0, 0, -0.14]} scale={[side, 1, 1]}>
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.72} transparent opacity={0.16} roughness={0.15} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>)}
    <mesh ref={core} position={[0, 1.68, 0.14]} scale={[0.38, 0.64, 0.14]}>
      <icosahedronGeometry args={[1, 2]} /><meshBasicMaterial color={color} transparent opacity={0.3} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
    </mesh>
    <points ref={particles} geometry={particleGeometry} position={[0, -0.6, 0.25]}>
      <pointsMaterial color={color} size={0.11} transparent opacity={0.95} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
    <pointLight ref={light} position={[0, 1.65, 0.45]} color={color} intensity={0} distance={8} decay={2} />
    {config.role === 0 && <group position={[0, 1.1, 0.4]} rotation={[Math.PI / 2, 0, 0]}>
      {[0, 1, 2].map((i) => <mesh key={i} rotation={[0, 0, i * 0.12]}><torusGeometry args={[0.95 + i * 0.36, 0.018, 6, 72]} /><meshBasicMaterial color={color} transparent opacity={0.75} blending={THREE.AdditiveBlending} depthWrite={false} /></mesh>)}
    </group>}
  </group>
}

function EnergyAcrossStone() {
  const purple = useRef<THREE.MeshBasicMaterial>(null)
  const red = useRef<THREE.MeshBasicMaterial>(null)
  const green = useMemo(() => new THREE.MeshBasicMaterial({ color: '#64ff9d', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }), [])
  const crackGlow = useMemo(() => new THREE.MeshBasicMaterial({ color: '#b9ffd0', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), [])
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    const successful = seq.ending.outcome === 'success'
    const p = seq.ending.progress
    const purpleEnding = successful ? smoothstep(0.1, 0.19, p) * (1 - smoothstep(0.34, 0.44, p)) : 0
    const redEnding = successful ? smoothstep(0.2, 0.29, p) * (1 - smoothstep(0.39, 0.49, p)) : 0
    const greenEnding = successful ? smoothstep(0.3, 0.39, p) * (1 - smoothstep(0.43, 0.53, p)) : 0
    const story = seq.exploration.storyProgress
    if (purple.current) purple.current.opacity = Math.max(0.95 * smoothstep(0.1, 0.14, story) * (1 - smoothstep(0.21, 0.26, story)), purpleEnding)
    if (red.current) red.current.opacity = Math.max(0.95 * smoothstep(0.32, 0.36, story) * (1 - smoothstep(0.45, 0.5, story)) * (0.85 + Math.sin(t * 8) * 0.15), redEnding)
    green.opacity = Math.max(0.95 * smoothstep(0.56, 0.6, story) * (1 - smoothstep(0.69, 0.74, story)) * (0.9 + Math.sin(t * 5) * 0.1), greenEnding)
    crackGlow.opacity = successful ? 0.92 * smoothstep(0.5, 0.62, p) * (1 - smoothstep(0.9, 1, p)) : 0
  })
  const line = (points: THREE.Vector3[]) => new THREE.CatmullRomCurve3(points)
  const paths = useMemo(() => [
    line([new THREE.Vector3(-0.22, 3.7, 0.74), new THREE.Vector3(-0.05, 3.3, 0.74), new THREE.Vector3(-0.35, 2.9, 0.74), new THREE.Vector3(-0.1, 2.4, 0.74)]),
    line([new THREE.Vector3(0.65, 3.2, 0.74), new THREE.Vector3(0.38, 2.9, 0.74), new THREE.Vector3(0.55, 2.35, 0.74), new THREE.Vector3(0.25, 1.9, 0.74)]),
    line([new THREE.Vector3(-0.85, 2.3, 0.74), new THREE.Vector3(-0.5, 2.05, 0.74), new THREE.Vector3(-0.65, 1.65, 0.74)]),
  ], [])
  return <group position={GRAVE}>
    {paths.map((p, i) => <mesh key={i}><tubeGeometry args={[p, 24, 0.05, 6, false]} /><meshBasicMaterial ref={i === 0 ? purple : red} color={i === 0 ? '#b980ff' : '#ff423b'} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} /></mesh>)}
    {paths.map((p, i) => <mesh key={`green-${i}`}><tubeGeometry args={[p, 24, 0.072, 6, false]} /><primitive object={green} attach="material" /></mesh>)}
    {paths.map((p, i) => <mesh key={`crack-glow-${i}`}><tubeGeometry args={[p, 24, 0.09, 6, false]} /><primitive object={crackGlow} attach="material" /></mesh>)}
  </group>
}

function ResurrectionLight() {
  const glow = useRef<THREE.SpriteMaterial>(null)
  const lamp = useRef<THREE.PointLight>(null)
  useFrame(({ clock }) => {
    const opening = seq.ending.outcome === 'success' ? smoothstep(0.73, 0.87, seq.ending.progress) * (1 - smoothstep(0.98, 1, seq.ending.progress)) : 0
    const pulse = 0.88 + Math.sin(clock.elapsedTime * 11) * 0.12
    if (glow.current) glow.current.opacity = opening * pulse * 0.95
    if (lamp.current) lamp.current.intensity = opening * pulse * 42
  })
  return <group position={[GRAVE.x, 3.2, GRAVE.z - 0.5]}>
    <sprite scale={[18, 18, 1]}><spriteMaterial ref={glow} map={createGlowTexture(256)} color="#b9ffd0" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} /></sprite>
    <pointLight ref={lamp} color="#baffd0" intensity={0} distance={58} decay={1.4} />
  </group>
}

function GraveMist() {
  const refs = useRef<(THREE.Sprite | null)[]>([])
  const maps = useMemo(() => [0, 1, 2].map((i) => createFogTexture(i * 13 + 5)), [])
  useFrame(({ clock }, delta) => {
    const dt = Math.min(delta, 0.05)
    // The clearing is first veiled in local mist; the mist parts as the visitor closes in.
    const reveal = smoothstep(0.05, 0.18, seq.exploration.nearMain)
      * (1 - smoothstep(0.28, 0.64, seq.exploration.nearMain))
      * (1 - seq.ending.fogFade)
    refs.current.forEach((sprite, i) => {
      if (!sprite) return
      sprite.position.x += (i % 2 ? -1 : 1) * dt * (0.16 + (i % 4) * 0.08)
      sprite.position.y = 0.55 + Math.sin(clock.elapsedTime * 0.3 + i) * 0.16
      const mat = sprite.material as THREE.SpriteMaterial
      mat.opacity = reveal * (0.22 + (i % 4) * 0.045)
    })
  })
  return <group>
    {Array.from({ length: 18 }, (_, i) => <sprite key={i} ref={(el) => { refs.current[i] = el }} position={[GRAVE.x + Math.sin(i * 9.7) * (3 + i % 5), 0.5 + (i % 3) * 0.3, GRAVE.z - 2 + Math.cos(i * 8.1) * 4]} scale={[8 + (i % 5) * 2, 2.3 + (i % 3), 1]}>
      <spriteMaterial map={maps[i % maps.length]} color="#9aafbf" transparent opacity={0} depthWrite={false} />
    </sprite>)}
  </group>
}

function RepairAttemptPulse() {
  const halo = useRef<THREE.SpriteMaterial>(null)
  const light = useRef<THREE.PointLight>(null)
  useFrame(({ clock }) => {
    const story = seq.exploration.storyProgress
    const attempt = smoothstep(0.72, 0.93, story) * (1 - smoothstep(0.985, 1, story))
    const verified = seq.ending.outcome === 'success'
    const intensity = attempt * (0.6 + Math.sin(clock.elapsedTime * 8) * 0.16)
    if (halo.current) halo.current.opacity = verified ? 0 : intensity * 0.22
    if (light.current) light.current.intensity = verified ? 0 : intensity * 4.2
  })
  return <group position={[GRAVE.x, 2.6, GRAVE.z - 0.7]}>
    <sprite scale={[9, 9, 1]}>
      <spriteMaterial ref={halo} map={createGlowTexture(128)} color="#d5efff" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
    </sprite>
    <pointLight ref={light} color="#a9ddff" intensity={0} distance={19} decay={2} />
  </group>
}

function ResurrectionParticles() {
  const particleMap = useMemo(() => createGlowTexture(32), [])
  useEffect(() => () => particleMap.dispose(), [particleMap])
  const points = useRef<THREE.Points>(null)
  const data = useMemo(() => {
    const positions = new Float32Array(260 * 3)
    for (let i = 0; i < 260; i++) {
      const a = i * 2.399
      const r = 0.2 + (i % 23) * 0.065
      positions[i * 3] = Math.cos(a) * r
      positions[i * 3 + 1] = (i % 29) * 0.14
      positions[i * 3 + 2] = Math.sin(a) * r
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return geometry
  }, [])
  const material = useRef<THREE.PointsMaterial>(null)
  useFrame(({ clock }) => {
    const rise = seq.ending.outcome === 'success' ? smoothstep(0.78, 0.88, seq.ending.progress) * (1 - smoothstep(0.98, 1, seq.ending.progress)) : 0
    if (points.current) {
      points.current.visible = rise > 0.01
      points.current.position.y = rise * (0.3 + (clock.elapsedTime % 8) * 0.58)
      points.current.rotation.y = clock.elapsedTime * 0.12
    }
    if (material.current) material.current.opacity = rise * 0.95
  })
  return <points ref={points} geometry={data} position={GRAVE} visible={false}>
    <pointsMaterial ref={material} map={particleMap} color="#c3ffd8" size={0.08} transparent opacity={0} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
  </points>
}

/** A small, human-scaled repository spirit rises only after a verified repair. */
function ReturningSoul() {
  const root = useRef<THREE.Group>(null)
  const veil = useRef<THREE.MeshStandardMaterial>(null)
  const core = useRef<THREE.MeshBasicMaterial>(null)
  const aura = useRef<THREE.SpriteMaterial>(null)
  const light = useRef<THREE.PointLight>(null)
  const body = useMemo(() => new THREE.LatheGeometry([
    new THREE.Vector2(0.04, 0), new THREE.Vector2(0.3, 0.18), new THREE.Vector2(0.42, 0.72),
    new THREE.Vector2(0.35, 1.35), new THREE.Vector2(0.23, 1.9), new THREE.Vector2(0.12, 2.2), new THREE.Vector2(0.01, 2.3),
  ], 24), [])

  useFrame(({ clock }) => {
    const progress = seq.ending.progress
    const active = seq.ending.outcome === 'success'
    const emergence = active ? smoothstep(0.81, 0.87, progress) * (1 - smoothstep(0.97, 1, progress)) : 0
    const rise = smoothstep(0.81, 0.96, progress)
    if (root.current) {
      root.current.visible = emergence > 0.005
      root.current.position.set(GRAVE.x, 0.42 + rise * 2.6, GRAVE.z + 0.42)
      root.current.rotation.y = Math.sin(clock.elapsedTime * 0.7) * 0.16
      root.current.scale.setScalar(0.76 + emergence * 0.24)
    }
    if (veil.current) veil.current.opacity = emergence * 0.34
    if (core.current) core.current.opacity = emergence * 0.74
    if (aura.current) aura.current.opacity = emergence * (0.46 + Math.sin(clock.elapsedTime * 2.8) * 0.06)
    if (light.current) light.current.intensity = emergence * 3.5
  })

  return <group ref={root} position={GRAVE} visible={false}>
    <sprite position={[0, 1.25, -0.35]} scale={[4.2, 5.2, 1]}>
      <spriteMaterial ref={aura} map={createGlowTexture(192)} color="#c8ffdf" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
    </sprite>
    <mesh geometry={body}>
      <meshStandardMaterial ref={veil} color="#bfffd7" emissive="#7affb0" emissiveIntensity={0.8} transparent opacity={0} roughness={0.24} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
    <mesh position={[0, 1.76, 0.12]} scale={[0.24, 0.3, 0.23]}>
      <sphereGeometry args={[1, 16, 12]} />
      <meshBasicMaterial ref={core} color="#e0ffed" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
    </mesh>
    <pointLight ref={light} position={[0, 1.2, 0.4]} color="#baffd0" intensity={0} distance={12} decay={2} />
  </group>
}

export function GraveStory() {
  return <group>
    <GiantTree />
    <FinalGraveBeacon />
    <MainStone />
    <EnergyAcrossStone />
    <SoulMagic />
    <RitualAtmosphere />
    <RepairAttemptPulse />
    <ResurrectionLight />
    <ResurrectionParticles />
    <ReturningSoul />
    <GraveMist />
    <AnalystCharacter />
    <FixerCharacter />
    <TesterCharacter />
  </group>
}

useGLTF.preload('/models/dead-tree.glb')
