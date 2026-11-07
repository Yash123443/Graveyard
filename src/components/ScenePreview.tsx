import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import { seq } from '../animations/sequence'

/** Development-only, deterministic visual QA; never activated in production builds. */
export function ScenePreview() {
  const initialized = useRef(false)
  useFrame(() => {
    const params = new URLSearchParams(window.location.search)
    const mode = params.get('scenePreview')
    const requestedStory = Number(params.get('story') ?? '0.96')
    const previewStory = Number.isFinite(requestedStory) ? Math.max(0.01, Math.min(0.99, requestedStory)) : 0.96
    if (!import.meta.env.DEV || (mode !== 'ritual' && mode !== 'trees' && mode !== 'reading' && mode !== 'revival')) return
    Object.assign(seq.reveal, { veil: 0, light: 1, moon: 1, clouds: 1, trees: 1, fog: 1, gate: 1, stars: 1 })
    seq.introDone = true; seq.scroll = seq.scrollTarget = seq.cam = 1; seq.gateOpen = 1
    if (mode === 'revival') {
      seq.exploration.entered = true; seq.exploration.storyStarted = true; seq.exploration.storyProgress = 1; seq.exploration.nearMain = 1
      seq.roam.x = 0; seq.roam.z = -71.5; seq.roam.entryBlend = 1
      Object.assign(seq.ending, { started: true, outcome: 'success', progress: 0.93, gather: 1, cameraBack: 0, fogFade: 0.6, moonFade: 0 })
      return
    }
    if (mode === 'reading') {
      if (!initialized.current) {
        seq.exploration.entered = true; seq.exploration.storyStarted = false; seq.exploration.storyProgress = 0; seq.exploration.readingSeconds = 0
        seq.roam.x = 0; seq.roam.z = -71.5; seq.roam.entryBlend = 1
        seq.roam.yaw = seq.roam.targetYaw = 0; seq.roam.pitch = seq.roam.targetPitch = 0.08
        seq.ending.started = false; seq.ending.progress = 0; seq.ending.cameraBack = 0
        initialized.current = true
      }
      return
    }
    seq.exploration.entered = true; seq.exploration.storyStarted = mode === 'ritual'; seq.exploration.storyProgress = mode === 'ritual' ? previewStory : 0; seq.exploration.nearMain = mode === 'ritual' ? 1 : 0
    seq.roam.x = mode === 'ritual' ? 0 : -9; seq.roam.z = mode === 'ritual' ? -72 : -8; seq.roam.entryBlend = 1
    if (mode === 'trees') { seq.roam.yaw = seq.roam.targetYaw = -0.73; seq.roam.pitch = seq.roam.targetPitch = 0.18 }
    seq.ending.started = false; seq.ending.progress = 0; seq.ending.cameraBack = 0
  }, -2)
  return null
}
