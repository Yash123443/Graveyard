import { useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq, smoothstep, startFinalGraveStory } from '../animations/sequence'
import { groundHeight } from './Ground'
import { deadTreeCollision } from './DeadTreeCluster'
import { createFogTexture, createRustTextures, createStoneTextures } from '../utils/proceduralTextures'
import { getAudioStatus, playDistantCat, playGraveDiscovery } from '../audio/audioManager'
import { graveStories } from './graveStories'
import { selectNearestProximity } from './graveProximity'

interface GraveSpec { x: number; z: number; height: number; scale: number; yaw: number; lean: number; style: number; enterRadius: number; exitRadius: number }

function scatter() {
  const locations: [number, number][] = [
    [-8.5, -24], [10, -35], [-12.5, -48], [13.5, -58], [-9, -68], [9, -73],
  ]
  return locations.map(([x, z], i): GraveSpec => {
    return {
      x, z,
      height: 1.16 + ((i * 17) % 4) * 0.13,
      scale: 0.98 + ((i * 13) % 4) * 0.08,
      yaw: Math.sin(i * 3.8) * 0.28,
      lean: Math.sin(i * 2.15) * 0.07 + (i % 3 === 0 ? 0.07 : 0),
      style: i % 4,
      // Every plot owns a slightly different detection envelope. The wider
      // exit ring makes a stable handoff when walking between two stones.
      enterRadius: 5.35 + (i % 3) * 0.35,
      exitRadius: 6.85 + (i % 3) * 0.35,
    }
  })
}

function graveShape(style: number) {
  const shape = new THREE.Shape()
  if (style === 0) {
    shape.moveTo(-0.52, 0); shape.lineTo(-0.52, 1.02); shape.quadraticCurveTo(-0.52, 1.34, -0.2, 1.39); shape.quadraticCurveTo(0, 1.43, 0.2, 1.39); shape.quadraticCurveTo(0.52, 1.34, 0.52, 1.02); shape.lineTo(0.52, 0); shape.closePath()
  } else if (style === 1) {
    shape.moveTo(-0.52, 0); shape.lineTo(-0.52, 1.08); shape.lineTo(-0.34, 1.12); shape.lineTo(-0.04, 1.43); shape.lineTo(0.28, 1.13); shape.lineTo(0.5, 1.07); shape.lineTo(0.46, 0.34); shape.lineTo(0.52, 0); shape.closePath()
  } else if (style === 2) {
    shape.moveTo(-0.51, 0); shape.lineTo(-0.51, 0.95); shape.lineTo(-0.27, 0.95); shape.lineTo(-0.27, 1.2); shape.lineTo(-0.12, 1.2); shape.lineTo(-0.12, 1.42); shape.lineTo(0.12, 1.42); shape.lineTo(0.12, 1.2); shape.lineTo(0.27, 1.2); shape.lineTo(0.27, 0.95); shape.lineTo(0.51, 0.95); shape.lineTo(0.51, 0); shape.closePath()
  } else {
    shape.moveTo(-0.52, 0); shape.lineTo(-0.52, 1.0); shape.quadraticCurveTo(-0.52, 1.35, -0.14, 1.4); shape.lineTo(0.1, 1.3); shape.lineTo(0.26, 1.4); shape.lineTo(0.48, 1.1); shape.lineTo(0.38, 0.98); shape.lineTo(0.52, 0); shape.closePath()
  }
  return new THREE.ExtrudeGeometry(shape, { depth: 0.2, bevelEnabled: true, bevelSegments: 3, bevelSize: 0.045, bevelThickness: 0.055 })
}

function makeEngravingTexture(title: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 192
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(222,216,198,.9)'
  ctx.shadowColor = '#d5d0bf'
  ctx.shadowBlur = 2
  ctx.font = 'bold 32px Georgia, serif'
  const words = title.split(' ')
  const lines: string[] = []
  let line = ''
  words.forEach((word) => {
    const next = line ? `${line} ${word}` : word
    if (ctx.measureText(next).width > 420 && line) { lines.push(line); line = word }
    else line = next
  })
  if (line) lines.push(line)
  const rowStart = lines.length > 1 ? 66 : 82
  lines.slice(0, 2).forEach((text, index) => ctx.fillText(text, 256, rowStart + index * 39))
  ctx.shadowBlur = 0
  ctx.strokeStyle = 'rgba(198,188,164,.55)'
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(92, 142); ctx.lineTo(420, 142); ctx.stroke()
  ctx.fillStyle = 'rgba(196,188,166,.7)'
  ctx.font = 'italic 24px Georgia, serif'
  ctx.fillText('REST IN PEACE', 256, 174)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function makeBeveledBlock() {
  const shape = new THREE.Shape()
  shape.moveTo(-0.5, -0.5); shape.lineTo(0.5, -0.5); shape.lineTo(0.5, 0.5); shape.lineTo(-0.5, 0.5); shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: true, bevelSegments: 2, bevelSize: 0.035, bevelThickness: 0.035 })
  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, -0.5, 0)
  return geometry
}

function makePlotFence(specs: GraveSpec[]) {
  const texture = createRustTextures(256)
  const metal = new THREE.MeshStandardMaterial({ map: texture.map, bumpMap: texture.bumpMap, bumpScale: 0.42, color: '#665541', metalness: 0.58, roughness: 0.86 })
  const railGeometry = new THREE.CylinderGeometry(0.032, 0.04, 1, 7)
  const postGeometry = new THREE.CylinderGeometry(0.065, 0.075, 0.92, 7)
  const picketGeometry = new THREE.CylinderGeometry(0.026, 0.035, 0.72, 6)
  const rails = new THREE.InstancedMesh(railGeometry, metal, specs.length * 12)
  const posts = new THREE.InstancedMesh(postGeometry, metal, specs.length * 6)
  const pickets = new THREE.InstancedMesh(picketGeometry, metal, specs.length * 12)
  const matrix = new THREE.Matrix4()
  const point = new THREE.Vector3()
  const scale = new THREE.Vector3(1, 1, 1)
  const up = new THREE.Vector3(0, 1, 0)
  const tangent = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  let railIndex = 0
  let postIndex = 0
  let picketIndex = 0

  specs.forEach((grave) => {
    const base = groundHeight(grave.x, grave.z)
    const localPoint = (x: number, z: number, y: number) => point.set(
      grave.x + x * Math.cos(grave.yaw) + z * Math.sin(grave.yaw),
      base + y,
      grave.z - x * Math.sin(grave.yaw) + z * Math.cos(grave.yaw),
    )
    const rail = (x: number, z: number, y: number, length: number, alongX: boolean) => {
      localPoint(x, z, y)
      tangent.set(alongX ? Math.cos(grave.yaw) : -Math.sin(grave.yaw), 0, alongX ? -Math.sin(grave.yaw) : Math.cos(grave.yaw))
      quaternion.setFromUnitVectors(up, tangent)
      scale.set(1, length, 1)
      matrix.compose(point, quaternion, scale)
      rails.setMatrixAt(railIndex++, matrix)
    }
    ;[-1.15, 1.15].forEach((x) => [0.38, 0.74].forEach((y) => rail(x, 0.58, y, 2.42, false)))
    ;[-0.55, 2.05].forEach((z) => [0.38, 0.74].forEach((y) => rail(0, z, y, 2.3, true)))
    ;[-0.79, 0.79].forEach((x) => [0.38, 0.74].forEach((y) => rail(x, 2.05, y, 0.72, true)))

    const postPositions: [number, number][] = [
      [-1.15, -0.62], [1.15, -0.62], [-1.15, 1.78], [1.15, 1.78], [-1.15, 0.58], [1.15, 0.58],
    ]
    postPositions.forEach(([x, z]) => {
      localPoint(x, z, 0.51)
      quaternion.identity()
      scale.set(1, 1, 1)
      matrix.compose(point, quaternion, scale)
      posts.setMatrixAt(postIndex++, matrix)
    })
    ;[-1.15, 1.15].forEach((x) => {
      for (let i = 0; i < 6; i += 1) {
        const z = -0.42 + i * 0.4
        localPoint(x, z, 0.48)
        quaternion.identity()
        scale.set(1, 1, 1)
        matrix.compose(point, quaternion, scale)
        pickets.setMatrixAt(picketIndex++, matrix)
      }
    })
  })
  rails.instanceMatrix.needsUpdate = true
  posts.instanceMatrix.needsUpdate = true
  pickets.instanceMatrix.needsUpdate = true
  rails.castShadow = posts.castShadow = pickets.castShadow = true
  rails.receiveShadow = posts.receiveShadow = pickets.receiveShadow = true
  return { rails, posts, pickets }
}

export function ScatteredGraves() {
  const { bones, materials, specs, groups, mossData, engravings, plotFence } = useMemo(() => {
    const specs = scatter()
    const textures = createStoneTextures(256)
    const materials = [0, 1, 2, 3].map((i) => new THREE.MeshStandardMaterial({
      map: textures.map, bumpMap: textures.bumpMap, bumpScale: 0.26,
      // Lift the weathered stone albedo so the aged fronts remain legible in moonlight.
      color: ['#c0b5a2', '#aaa08f', '#bbb09d', '#9d9587'][i], roughness: 0.97,
    }))
    const bones = [0, 1, 2, 3].map(graveShape)
    const groups = [0, 1, 2, 3].map((style) => specs.map((g, index) => ({ ...g, index })).filter((g) => g.style === style))
    const mossData = specs.flatMap((g, i) => [0, 1].map((n) => ({
      x: g.x + Math.sin(i * 8.1 + n) * 0.26,
      y: groundHeight(g.x, g.z) + 0.12 + n * 0.08,
      z: g.z + Math.cos(i * 4.7 + n) * 0.15,
      size: 0.18 + (i % 3) * 0.045,
      yaw: g.yaw,
    })))
    const engravings = graveStories.map((story) => makeEngravingTexture(story.name))
    const plotFence = makePlotFence(specs)
    return { bones, materials, specs, groups, mossData, engravings, plotFence }
  }, [])
  const refs = useRef<(THREE.InstancedMesh | null)[]>([])
  const bases = useRef<THREE.InstancedMesh>(null)
  const caps = useRef<THREE.InstancedMesh>(null)
  const mounds = useRef<THREE.InstancedMesh>(null)
  const moss = useRef<THREE.InstancedMesh>(null)
  const graveMists = useRef<(THREE.Sprite | null)[]>([])
  const engravingMaterials = useRef<(THREE.MeshStandardMaterial | null)[]>([])
  const graveLight = useRef<THREE.PointLight>(null)
  const activeGrave = useRef(-1)
  const fogTexture = useMemo(() => createFogTexture(77), [])
  const catSoundArmed = useRef(false)
  const nextCatSound = useRef(0)
  const matrix = useMemo(() => new THREE.Matrix4(), [])
  const position = useMemo(() => new THREE.Vector3(), [])
  const rotation = useMemo(() => new THREE.Quaternion(), [])
  const scale = useMemo(() => new THREE.Vector3(), [])
  const euler = useMemo(() => new THREE.Euler(), [])
  const crackSets = useMemo(() => specs.map((grave, index) => {
    const paths: [number, number, number][][] = [
      [[-0.18, 1.16, 0.268], [-0.04, 0.97, 0.268], [-0.19, 0.76, 0.268], [-0.08, 0.55, 0.268]],
      [[0.26, 0.92, 0.268], [0.1, 0.77, 0.268], [0.22, 0.62, 0.268]],
      [[-0.08, 0.55, 0.268], [-0.32, 0.42, 0.268], [-0.38, 0.24, 0.268]],
    ]
    return paths.slice(0, index % 3 + 1).map((points, crackIndex) => {
      const shifted = points.map(([x, y, z]) => [x + Math.sin(index * 7 + crackIndex) * 0.08, y - (index % 2) * 0.08, z] as [number, number, number])
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(shifted.map((point) => new THREE.Vector3(...point))), 16, 0.012, 4, false)
    })
  }), [specs])

  useEffect(() => {
    seq.exploration.obstacles = [
      ...specs.map((grave) => ({ x: grave.x, z: grave.z, radius: 1.45 * grave.scale })),
      ...deadTreeCollision,
      { x: 0, z: -83, radius: 2.3 },
      { x: 5.5, z: -94, radius: 3.3 },
    ]
    return () => { seq.exploration.obstacles = [] }
  }, [specs])

  useLayoutEffect(() => {
    groups.forEach((group, style) => group.forEach((grave, localIndex) => {
      euler.set(grave.lean, grave.yaw, 0)
      rotation.setFromEuler(euler)
      position.set(grave.x, groundHeight(grave.x, grave.z) + 0.38, grave.z)
      scale.set(grave.scale, grave.height * grave.scale, grave.scale)
      matrix.compose(position, rotation, scale)
      refs.current[style]?.setMatrixAt(localIndex, matrix)
      refs.current[style]?.setColorAt(localIndex, new THREE.Color('#ffffff'))
    }))
    if (refs.current.length) refs.current.forEach((mesh) => {
      if (!mesh) return
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    })

    specs.forEach((grave, index) => {
      euler.set(0, grave.yaw, 0)
      rotation.setFromEuler(euler)
      position.set(grave.x, groundHeight(grave.x, grave.z) + 0.14, grave.z + 0.03)
      scale.set(1.26 * grave.scale, 0.28, 0.68 * grave.scale)
      matrix.compose(position, rotation, scale)
      bases.current?.setMatrixAt(index, matrix)

      position.set(grave.x, groundHeight(grave.x, grave.z) + 0.31, grave.z + 0.03)
      scale.set(1.02 * grave.scale, 0.18, 0.53 * grave.scale)
      matrix.compose(position, rotation, scale)
      caps.current?.setMatrixAt(index, matrix)

      // Low earthen burial mound, with the headstone rising at its back edge.
      position.set(grave.x, groundHeight(grave.x, grave.z) + 0.12, grave.z + 0.42)
      scale.set(1.42 * grave.scale, 0.29 * grave.scale, 0.86 * grave.scale)
      matrix.compose(position, rotation, scale)
      mounds.current?.setMatrixAt(index, matrix)
    })
    if (bases.current) bases.current.instanceMatrix.needsUpdate = true
    if (caps.current) caps.current.instanceMatrix.needsUpdate = true
    if (mounds.current) mounds.current.instanceMatrix.needsUpdate = true

    mossData.forEach((patch, index) => {
      position.set(patch.x, patch.y, patch.z)
      euler.set(0, patch.yaw + index * 1.2, 0)
      rotation.setFromEuler(euler)
      scale.set(patch.size, patch.size * 0.46, patch.size * 0.62)
      matrix.compose(position, rotation, scale)
      moss.current?.setMatrixAt(index, matrix)
    })
    if (moss.current) moss.current.instanceMatrix.needsUpdate = true
  }, [bones, euler, groups, matrix, mossData, position, rotation, scale, specs])

  useFrame(({ camera, clock }, delta) => {
    if (!seq.exploration.entered) {
      catSoundArmed.current = false
    } else if (!catSoundArmed.current) {
      catSoundArmed.current = true
      nextCatSound.current = clock.elapsedTime + 18
    } else if (clock.elapsedTime >= nextCatSound.current) {
      if (getAudioStatus() === 'on') playDistantCat()
      nextCatSound.current = clock.elapsedTime + 28 + Math.random() * 22
    }

    const previous = activeGrave.current
    const nearIndex = seq.exploration.entered
      ? selectNearestProximity(specs, camera.position.x, camera.position.z, previous)
      : -1
    if (nearIndex !== previous) {
      const tint = (index: number, color: string) => {
        if (index < 0) return
        const spec = specs[index]
        const localIndex = groups[spec.style].findIndex((item) => item.index === index)
        if (localIndex >= 0) refs.current[spec.style]?.setColorAt(localIndex, new THREE.Color(color))
      }
      tint(previous, '#ffffff')
      tint(nearIndex, '#cce4f7')
      if (nearIndex >= 0) playGraveDiscovery()
      refs.current.forEach((mesh) => { if (mesh?.instanceColor) mesh.instanceColor.needsUpdate = true })
      activeGrave.current = nearIndex
      if (nearIndex >= 0 && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('graveyard:grave-enter', { detail: { index: nearIndex } }))
      }
    }
    seq.exploration.nearGrave = nearIndex
    seq.exploration.graveFocus = THREE.MathUtils.damp(seq.exploration.graveFocus, nearIndex >= 0 ? 1 : 0, 5.5, Math.min(delta, 0.05))
    const mainDistance = Math.hypot(camera.position.x, camera.position.y - 2.5, camera.position.z + 83)
    // The central grave stays a distant landmark, but its record and story
    // remain dormant until the visitor reaches its own clearing.
    seq.exploration.nearMain = smoothstep(14, 6, mainDistance) * Number(seq.exploration.entered)
    // Nearby ordinary graves must never start the final cinematic. The
    // landmark can be seen from afar, but it is only activated at its own plot.
    if (mainDistance < 7.5) startFinalGraveStory()
    const dt = Math.min(delta, 0.05)
    specs.forEach((grave, index) => {
      const mist = graveMists.current[index]
      if (!mist) return
      const distance = Math.hypot(camera.position.x - grave.x, camera.position.z - grave.z)
      const selected = index === nearIndex ? seq.exploration.graveFocus : 0
      const range = smoothstep(17, 8, distance)
      // A selected plot clears first, while unselected graves retain their low fog.
      const targetOpacity = seq.reveal.fog * (0.035 + 0.11 * range) * (1 - selected * 0.9) * (1 - seq.ending.fogFade)
      mist.position.x = grave.x + Math.sin(clock.elapsedTime * 0.16 + index * 2.3) * 0.55
      mist.position.y = 0.38 + Math.sin(clock.elapsedTime * 0.28 + index) * 0.09
      mist.position.z = grave.z + Math.cos(clock.elapsedTime * 0.13 + index * 1.8) * 0.4
      mist.material.opacity = THREE.MathUtils.damp(mist.material.opacity, targetOpacity, 2.5, dt)
    })
    const target = specs[Math.max(0, nearIndex)]
    if (graveLight.current) {
      graveLight.current.position.x = THREE.MathUtils.damp(graveLight.current.position.x, target.x, 4, dt)
      graveLight.current.position.z = THREE.MathUtils.damp(graveLight.current.position.z, target.z, 4, dt)
      graveLight.current.intensity = THREE.MathUtils.damp(graveLight.current.intensity, nearIndex >= 0 ? 1.8 : 0, 4, dt)
    }
    engravingMaterials.current.forEach((material, index) => {
      if (!material) return
      const selected = index === nearIndex ? seq.exploration.graveFocus : 0
      material.color.setRGB(0.75 + selected * 0.2, 0.71 + selected * 0.23, 0.62 + selected * 0.31)
      material.emissive.setRGB(0.04 * selected, 0.09 * selected, 0.13 * selected)
      material.emissiveIntensity = selected * 0.8
      material.opacity = 0.68 + selected * 0.32
    })
  })

  return <group>
    {groups.map((group, style) => <instancedMesh key={`stone-${style}`} ref={(mesh) => { refs.current[style] = mesh }} args={[bones[style], materials[style], group.length]} castShadow receiveShadow />)}
    <primitive object={plotFence.rails} />
    <primitive object={plotFence.posts} />
    <primitive object={plotFence.pickets} />
    {specs.map((grave, index) => <group key={`fracture-${index}`} position={[grave.x, groundHeight(grave.x, grave.z) + 0.38, grave.z]} rotation={[grave.lean, grave.yaw, 0]} scale={[grave.scale, grave.height * grave.scale, grave.scale]}>
      {crackSets[index].map((geometry, crack) => <mesh key={crack} geometry={geometry}>
        <meshStandardMaterial color="#242522" roughness={1} polygonOffset polygonOffsetFactor={-1} />
      </mesh>)}
      <mesh position={[0, 0.79, 0.275]}>
        <planeGeometry args={[0.82, 0.31]} />
        <meshStandardMaterial ref={(material) => { engravingMaterials.current[index] = material }} map={engravings[index]} transparent roughness={1} metalness={0} depthWrite={false} color="#c0b59f" />
      </mesh>
      {[[-0.3, 0.24, 0.275], [0.28, 0.34, 0.275], [0.02, 0.12, 0.28]].map(([x, y, z], patch) => <mesh key={`moss-${patch}`} position={[x, y, z]} scale={[0.19 + patch * 0.04, 0.07 + patch * 0.02, 0.025]}>
        <sphereGeometry args={[1, 10, 7]} />
        <meshStandardMaterial color={patch === 1 ? '#43503a' : '#354735'} roughness={1} />
      </mesh>)}
    </group>)}
    <instancedMesh ref={bases} args={[makeBeveledBlock(), materials[1], specs.length]} castShadow receiveShadow />
    <instancedMesh ref={caps} args={[makeBeveledBlock(), materials[0], specs.length]} castShadow receiveShadow />
    <instancedMesh ref={mounds} args={[new THREE.SphereGeometry(1, 14, 9), new THREE.MeshStandardMaterial({ color: '#352b22', roughness: 1 }), specs.length]} castShadow receiveShadow />
    <instancedMesh ref={moss} args={[new THREE.SphereGeometry(1, 8, 6), new THREE.MeshStandardMaterial({ color: '#40523b', roughness: 1 }), mossData.length]} castShadow />
    {specs.map((grave, index) => <sprite key={`grave-mist-${index}`} ref={(sprite) => { graveMists.current[index] = sprite }} position={[grave.x, 0.38, grave.z]} scale={[5.5, 1.45, 1]}>
      <spriteMaterial map={fogTexture} color="#9f9585" transparent opacity={0} depthWrite={false} />
    </sprite>)}
    <pointLight ref={graveLight} position={[0, 3, 0]} color="#d6b37b" intensity={0} distance={9} decay={2} />
  </group>
}
