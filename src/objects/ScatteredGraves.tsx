import { dressingObstacles } from './CemeteryDressing'
import { useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq, smoothstep, startFinalGraveStory } from '../animations/sequence'
import { groundHeight } from './Ground'
import { deadTreeCollision } from './DeadTreeCluster'
import { createFogTexture, createRustTextures, createStoneTextures } from '../utils/proceduralTextures'
import { getAudioStatus, playDistantCat, playGraveDiscovery } from '../audio/audioManager'
import { graveStories } from './graveStories'
import { advanceGraveReading, GRAVE_READING_SECONDS } from '../animations/graveEncounter'
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
 const shape=new THREE.Shape()
 shape.moveTo(-.52,0);shape.lineTo(-.52,1.04)
 // Four quiet memorial silhouettes: round arch, pediment, shoulders and tablet.
 if(style===0){shape.bezierCurveTo(-.52,1.52,.52,1.52,.52,1.04)}
 else if(style===1){shape.lineTo(-.52,1.18);shape.lineTo(0,1.43);shape.lineTo(.52,1.18);shape.lineTo(.52,1.04)}
 else if(style===2){shape.lineTo(-.36,1.04);shape.quadraticCurveTo(-.36,1.4,0,1.4);shape.quadraticCurveTo(.36,1.4,.36,1.04);shape.lineTo(.52,1.04)}
 else {shape.lineTo(-.45,1.3);shape.lineTo(.45,1.3);shape.lineTo(.52,1.04)}
 shape.lineTo(.52,0);shape.closePath()
 return new THREE.ExtrudeGeometry(shape,{depth:.24,bevelEnabled:true,bevelSegments:2,bevelSize:.035,bevelThickness:.035,curveSegments:16})
}

function makeEngravingTexture(title: string) {
 const canvas=document.createElement('canvas');canvas.width=768;canvas.height=512
 const ctx=canvas.getContext('2d')!
 // Transparent canvas: only the carved letter shapes receive emission.
 ctx.clearRect(0,0,768,512)
 ctx.textAlign='center';ctx.fillStyle='#d6cbb2';ctx.font='28px Georgia'
 ctx.fillText('IN MEMORY OF',384,65)
 const words=title.replace(/^THE /,'').split(' ');const rows:string[]=[];let line=''
 ctx.font='600 48px Georgia'
 words.forEach(word=>{const next=line?line+' '+word:word;if(ctx.measureText(next).width>650&&line){rows.push(line);line=word}else line=next})
 if(line)rows.push(line)
 rows.forEach((row,i)=>ctx.fillText(row,384,175+i*66))

 ctx.font='italic 35px Georgia';ctx.fillText('Rest in peace',384,410)
 const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace
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
      tangent.set(alongX ? Math.cos(grave.yaw) : Math.sin(grave.yaw), 0, alongX ? -Math.sin(grave.yaw) : Math.cos(grave.yaw))
      quaternion.setFromUnitVectors(up, tangent)
      scale.set(1, length, 1)
      matrix.compose(point, quaternion, scale)
      rails.setMatrixAt(railIndex++, matrix)
    }
    ;[-1.15, 1.15].forEach((x) => [0.38, 0.74].forEach((y) => rail(x, 0.75, y, 2.6, false)))
    ;[0.38, 0.74].forEach(y => rail(0, -.55, y, 2.3, true))
    // Leave a central entrance aligned with the stepping-stone approach.
    ;[-.85,.85].forEach(x => [0.38,0.74].forEach(y => rail(x,2.05,y,.6,true)))


    const postPositions: [number, number][] = [
      [-1.15, -0.55], [1.15, -0.55], [-1.15, 2.05], [1.15, 2.05], [-1.15, 0.58], [1.15, 0.58],
    ]
    postPositions.forEach(([x, z]) => {
      localPoint(x, z, 0.42)
      quaternion.identity()
      scale.set(1, 1, 1)
      matrix.compose(point, quaternion, scale)
      posts.setMatrixAt(postIndex++, matrix)
    })
    ;[-1.15, 1.15].forEach((x) => {
      for (let i = 0; i < 6; i += 1) {
        const z = -0.42 + i * 0.46
        localPoint(x, z, 0.32)
        quaternion.identity()
        scale.set(1, 1, 1)
        matrix.compose(point, quaternion, scale)
        pickets.setMatrixAt(picketIndex++, matrix)
      }
    })
  })
  rails.count = railIndex
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
      map: textures.map, roughnessMap: textures.bumpMap, bumpMap: textures.bumpMap, bumpScale: 0.035,
      // Lift the weathered stone albedo so the aged fronts remain legible in moonlight.
      color: ['#b0ac9f', '#929fa2', '#aa9f8d', '#8f9691'][i], roughness: 0.97,
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
  const mainDwell = useRef(0)
  const viewingDirection = useMemo(() => new THREE.Vector3(), [])
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
    return paths.slice(0, 1).map((points, crackIndex) => {
      const shifted = points.map(([x, y, z]) => [x + Math.sin(index * 7 + crackIndex) * 0.08, y - (index % 2) * 0.08, z] as [number, number, number])
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(shifted.map((point) => new THREE.Vector3(...point))), 16, 0.005, 4, false)
    })
  }), [specs])

  useEffect(() => {
    seq.exploration.obstacles = [
      ...specs.map((grave) => ({ x: grave.x, z: grave.z, radius: 1.45 * grave.scale })),
      ...deadTreeCollision,
      ...dressingObstacles,
      { x: 0, z: -83, radius: 1.6 },
      { x: 0, z: -80.7, radius: 1.6 },
      { x: 0, z: -78.7, radius: 1.6 },
      { x: 5.5, z: -94, radius: 3.3 },
    ]
    return () => { seq.exploration.obstacles = [] }
  }, [specs])

  useLayoutEffect(() => {
    groups.forEach((group, style) => group.forEach((grave, localIndex) => {
      euler.set(grave.lean, grave.yaw, 0)
      rotation.setFromEuler(euler)
      position.set(grave.x, groundHeight(grave.x, grave.z) + 0.12, grave.z)
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
      position.set(grave.x, groundHeight(grave.x, grave.z) - 0.16, grave.z + 0.03)
      scale.set(1.36 * grave.scale, 0.6, 0.68 * grave.scale)
      matrix.compose(position, rotation, scale)
      bases.current?.setMatrixAt(index, matrix)

      position.set(grave.x, groundHeight(grave.x, grave.z) + 0.09, grave.z + 0.03)
      scale.set(1.02 * grave.scale, 0.18, 0.53 * grave.scale)
      matrix.compose(position, rotation, scale)
      caps.current?.setMatrixAt(index, matrix)

      // Low earthen burial mound, with the headstone rising at its back edge.
      position.set(grave.x, groundHeight(grave.x, grave.z) - 0.07, grave.z + 0.65)
      scale.set(0.88 * grave.scale, 0.24 * grave.scale, 1.12 * grave.scale)
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
    const mainFocus = seq.exploration.storyStarted ? 1 : smoothstep(19, 12.5, mainDistance) * Number(seq.exploration.entered)
    seq.exploration.nearMain = THREE.MathUtils.damp(seq.exploration.nearMain, mainFocus, 4, Math.min(delta, 0.05))
    // Read from the clearing. Walking past or looking away cannot start the ritual.
    if (seq.exploration.entered && !seq.exploration.storyStarted) {
      camera.getWorldDirection(viewingDirection)
      const horizontalDistance = Math.hypot(camera.position.x, camera.position.z + 83)
      const facing = (-camera.position.x * viewingDirection.x - (camera.position.z + 83) * viewingDirection.z) / Math.max(0.01, horizontalDistance)
      mainDwell.current = advanceGraveReading(mainDwell.current, mainDistance, facing, Math.hypot(seq.roam.velocityX, seq.roam.velocityZ), delta)
      seq.exploration.readingSeconds = mainDwell.current
      if (mainDwell.current >= GRAVE_READING_SECONDS) startFinalGraveStory()
    }
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
      material.emissive.setRGB(0.78, 0.72, 0.55)
      material.emissiveIntensity = 0.45 + selected * 0.65
      material.opacity = 0.68 + selected * 0.32
    })
  })

  return <group>
    {groups.map((group, style) => <instancedMesh key={`stone-${style}`} ref={(mesh) => { refs.current[style] = mesh }} args={[bones[style], materials[style], group.length]} castShadow receiveShadow />)}
    <primitive object={plotFence.rails} />
    <primitive object={plotFence.posts} />
    <primitive object={plotFence.pickets} />
    {specs.map((grave, index) => <group key={`fracture-${index}`} position={[grave.x, groundHeight(grave.x, grave.z) + 0.12, grave.z]} rotation={[grave.lean, grave.yaw, 0]} scale={[grave.scale, grave.height * grave.scale, grave.scale]}>
      {crackSets[index].map((geometry, crack) => <mesh key={crack} geometry={geometry}>
        <meshStandardMaterial color="#242522" roughness={1} polygonOffset polygonOffsetFactor={-1} />
      </mesh>)}
      <mesh position={[0, 0.72, 0.29]}>
        <planeGeometry args={[0.82, 0.57]} />
        <meshStandardMaterial ref={(material) => { engravingMaterials.current[index] = material }} map={engravings[index]} emissiveMap={engravings[index]} toneMapped={false} transparent roughness={1} metalness={0} depthWrite={false} color="#c0b59f" />
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
