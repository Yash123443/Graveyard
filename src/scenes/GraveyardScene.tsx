import { Stars } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import * as THREE from 'three'
import { CameraRig } from '../animations/CameraRig'
import { seq } from '../animations/sequence'
import { BatFlight } from '../objects/BatFlight'
import { CemeteryGate } from '../objects/CemeteryGate'
import { CircularCemeteryFence } from '../objects/CircularCemeteryFence'
import { CemeteryGroundDetails } from '../objects/CemeteryGroundDetails'
import { CloudLayers } from '../objects/CloudLayers'
import { DeadGrass } from '../objects/DeadGrass'
import { DeadTreeCluster } from '../objects/DeadTreeCluster'
import { DustParticles } from '../objects/DustParticles'
import { FogVolume } from '../objects/FogVolume'
import { Ground } from '../objects/Ground'
import { GraveStory } from '../objects/GraveStory'
import { HalloweenProps, TreePeekingGhosts } from '../objects/HalloweenAdditions'
import { ScatteredGraves } from '../objects/ScatteredGraves'
import { LeafLitter } from '../objects/LeafLitter'
import { MOON_POSITION, Moon } from '../objects/Moon'
import { Sky } from '../objects/Sky'

/** Light rig whose intensity is driven by the scene-1 reveal, so the world starts in near-total darkness. */
function Lights() {
  const moonLight = useRef<THREE.DirectionalLight>(null)
  const fill = useRef<THREE.DirectionalLight>(null)
  const hemi = useRef<THREE.HemisphereLight>(null)
  const ambient = useRef<THREE.AmbientLight>(null)

  useFrame(() => {
    const k = seq.reveal.light
    if (moonLight.current) moonLight.current.intensity = 2.35 * k
    if (fill.current) fill.current.intensity = 0.82 * k
    if (hemi.current) hemi.current.intensity = 0.42 * k
    if (ambient.current) ambient.current.intensity = 0.16 * k
  })

  return (
    <>
      <ambientLight ref={ambient} color="#1c2d43" intensity={0} />
      <hemisphereLight ref={hemi} color="#7f9db8" groundColor="#04060a" intensity={0} />
      {/* the moon itself, raking low from behind the gate so shadows stream toward the viewer */}
      <directionalLight
        ref={moonLight}
        castShadow
        color="#b6d5f2"
        intensity={0}
        position={[MOON_POSITION[0] * 0.55, MOON_POSITION[1] * 0.8, MOON_POSITION[2] * 0.55]}
        shadow-bias={-0.0002}
        shadow-normalBias={0.04}
        shadow-mapSize={[1024, 1024]}
        shadow-camera-near={5}
        shadow-camera-far={140}
        shadow-camera-left={-48}
        shadow-camera-right={48}
        shadow-camera-top={48}
        shadow-camera-bottom={-48}
      />
      {/* cold fill from the camera side so rust and stone texture stay legible */}
      <directionalLight ref={fill} color="#a18a6d" intensity={0} position={[-8, 7, 42]} />
    </>
  )
}

export function GraveyardScene() {
  return (
    <>
      <CameraRig />
      <Lights />
      <Sky />
      <Stars radius={260} depth={60} count={800} factor={4} saturation={0} fade speed={0.2} />
      <Moon />
      <CloudLayers />
      <Ground />
      <CircularCemeteryFence />
      <CemeteryGroundDetails />
      <ScatteredGraves />
      <DeadTreeCluster />
      <CemeteryGate />
      <HalloweenProps />
      <TreePeekingGhosts />
      <DeadGrass />
      <LeafLitter />
      <DustParticles />
      <FogVolume />
      <BatFlight />
      <GraveStory />
    </>
  )
}
