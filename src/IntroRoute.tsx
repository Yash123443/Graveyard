import { useEffect } from 'react'
import App from './App'
import { seq } from './animations/sequence'
import { fadeAmbience, stopGateCreak } from './audio/audioManager'

/** Hosts the unchanged intro and releases pointer lock, audio and held keys when the route is left. */
export default function IntroRoute() {
  useEffect(() => () => {
    if (document.pointerLockElement) document.exitPointerLock()
    stopGateCreak(0.25)
    fadeAmbience(0.5)
    for (const key of Object.keys(seq.roam.input) as (keyof typeof seq.roam.input)[]) seq.roam.input[key] = false
  }, [])
  return <App />
}
