import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { seq, smoothstep } from '../animations/sequence'
import { createWitchSoul } from './analyst/createWitchSoul'

/** Seconds of a character's own entrance timeline per unit of story progress (0.2 progress = fully materialized). */
const INTRO_SECONDS_PER_PROGRESS = 55

interface SpectreProps {
  variant: 'analyst' | 'fixer' | 'tester'
  /** Group origin in world space (main grave is at 0, 0, -83). */
  position: [number, number, number]
  /** Facing angle in radians (0 = toward the camera). */
  rotY: number
  scale: number
  /** storyProgress at which this character's slot begins. */
  start: number
}

/**
 * One procedural cinematic character. Its entrance (particles gather -> body materializes ->
 * pose settles) plays across its slot of the shared story clock, and it dissolves away with
 * the rest of the presences when the ending begins.
 */
function Spectre({ variant, position, rotY, scale, start }: SpectreProps) {
  const holder = useRef<THREE.Group>(null)
  const actor = useRef<ReturnType<typeof createWitchSoul> | null>(null)
  const gl = useThree((state) => state.gl)

  useEffect(() => {
    if (!holder.current) return
    const a = createWitchSoul(holder.current, { variant, rotY, scale, lightIntensity: 1.15, lightDistance: 9 })
    a.group.visible = false
    actor.current = a
    return () => {
      a.dispose()
      actor.current = null
    }
  }, [variant, rotY, scale])

  useFrame(({ clock }) => {
    const a = actor.current
    if (!a) return
    const local = seq.exploration.storyProgress - start
    const fade = seq.ending.started ? 1 - smoothstep(0.91, 0.99, seq.ending.progress) : 1
    a.group.visible = local > 0.002 && fade > 0.004
    if (!a.group.visible) return
    a.group.position.y = seq.ending.gather * 0.35
    a.setPixelRatio(gl.getPixelRatio())
    const T = local * INTRO_SECONDS_PER_PROGRESS
    a.set(T, clock.elapsedTime, T > 10.5 ? 1 : 0, fade)
  })

  return <group ref={holder} position={position} />
}

/** Purple forensic investigator: slim hooded occult soul with a partially revealed human face. Left of the grave. */
export function AnalystCharacter() {
  return <Spectre variant="analyst" position={[-2.85, 0.55, -80.5]} rotY={1.0} scale={1.58} start={0} />
}

/** Crimson repair specialist: broad hooded occult soul with ember-veined robes and red slit eyes. Right of the grave. */
export function FixerCharacter() {
  return <Spectre variant="fixer" position={[2.9, 0.55, -80.15]} rotY={-1.0} scale={1.58} start={0.24} />
}

/** Emerald verification specialist: hooded occult soul with green eyes and a restrained spectral orbit. Rises behind the grave. */
export function TesterCharacter() {
  return <Spectre variant="tester" position={[0, 0.9, -86.2]} rotY={0} scale={1.58} start={0.48} />
}
