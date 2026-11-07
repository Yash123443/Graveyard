import { useFrame } from '@react-three/fiber'
import { seq } from '../animations/sequence'

/** Development-only, deterministic visual QA; never activated in production builds. */
export function ScenePreview() {
  useFrame(() => {
    const mode = new URLSearchParams(window.location.search).get('scenePreview')
    if (!import.meta.env.DEV || (mode !== 'ritual' && mode !== 'trees')) return
    Object.assign(seq.reveal, { veil: 0, light: 1, moon: 1, clouds: 1, trees: 1, fog: 1, gate: 1, stars: 1 })
    seq.introDone = true; seq.scroll = seq.scrollTarget = seq.cam = 1; seq.gateOpen = 1
    seq.exploration.entered = true; seq.exploration.storyStarted = mode === 'ritual'; seq.exploration.storyProgress = mode === 'ritual' ? 0.96 : 0; seq.exploration.nearMain = mode === 'ritual' ? 1 : 0
    seq.roam.x = mode === 'ritual' ? 0 : -9; seq.roam.z = mode === 'ritual' ? -72 : -8; seq.roam.entryBlend = 1
    if (mode === 'trees') { seq.roam.yaw = seq.roam.targetYaw = -0.73; seq.roam.pitch = seq.roam.targetPitch = 0.18 }
    seq.ending.started = false; seq.ending.progress = 0; seq.ending.cameraBack = 0
  }, -2)
  return null
}
