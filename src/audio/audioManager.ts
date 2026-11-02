import gsap from 'gsap'

/**
 * Atmosphere + gate creak.
 * Browsers only allow audio after a user gesture, so nothing plays until
 * `unlock()` runs from a click / key / touch. Wheel events are not treated
 * as gestures by most browsers, so the mute control also acts as an explicit
 * "enable sound" affordance until audio is running.
 */

export type AudioStatus = 'locked' | 'on' | 'muted'

const AMBIENT_VOLUME = 0.38
const CREAK_VOLUME = 0.85

let ambience: HTMLAudioElement | null = null
let creak: HTMLAudioElement | null = null
let status: AudioStatus = 'locked'
let wantsSound = true // user has not muted
let creakPending = false
let effectContext: AudioContext | null = null
let effectMaster: GainNode | null = null
const listeners = new Set<() => void>()

const emit = () => listeners.forEach((l) => l())

export const subscribeAudio = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const getAudioStatus = () => status

function ensure() {
  if (ambience && creak) return
  ambience = new Audio('/sounds/ambient-graveyard.mp3')
  ambience.loop = true
  ambience.preload = 'none'
  ambience.volume = 0
  creak = new Audio('/sounds/gate-creak.mp3')
  creak.preload = 'none'
  creak.volume = CREAK_VOLUME
}

function ensureEffects() {
  if (effectContext || typeof window === 'undefined') return
  const AudioContextClass = window.AudioContext
  if (!AudioContextClass) return
  effectContext = new AudioContextClass()
  effectMaster = effectContext.createGain()
  effectMaster.gain.value = status === 'muted' ? 0 : 0.55
  effectMaster.connect(effectContext.destination)
}

export function preloadAudio() {
  ensure()
}

/** Duration of the creak in seconds (used to sync the gate swing). */
export function getCreakDuration(fallback = 8) {
  ensure()
  const d = creak!.duration
  return Number.isFinite(d) && d > 1 ? d : fallback
}

function startAmbience() {
  if (!ambience) return
  gsap.killTweensOf(ambience)
  ambience.muted = false
  ambience.preload = 'auto'
  void ambience
    .play()
    .then(() => {
      gsap.to(ambience!, { volume: AMBIENT_VOLUME, duration: 4, ease: 'power2.inOut' })
    })
    .catch(() => {
      // Autoplay still blocked: stay locked so the next gesture retries.
      status = 'locked'
      emit()
    })
}

/** Call from a real user gesture (pointerdown / keydown / touchend / click). */
export function unlockAudio() {
  ensure()
  ensureEffects()
  void effectContext?.resume()
  if (status !== 'locked') return
  if (!wantsSound) return
  status = 'on'
  emit()
  startAmbience()
  if (creakPending) {
    creakPending = false
    playGateCreak()
  }
}

export function toggleAudio() {
  ensure()
  if (status === 'on') {
    wantsSound = false
    status = 'muted'
    if (ambience) {
      gsap.killTweensOf(ambience)
      gsap.to(ambience, { volume: 0, duration: 0.5, onComplete: () => ambience?.pause() })
    }
    creak?.pause()
    if (effectContext && effectMaster) effectMaster.gain.setTargetAtTime(0, effectContext.currentTime, 0.06)
  } else {
    wantsSound = true
    status = 'on'
    startAmbience()
    ensureEffects()
    if (effectContext && effectMaster) {
      void effectContext.resume()
      effectMaster.gain.setTargetAtTime(0.55, effectContext.currentTime, 0.06)
    }
  }
  emit()
}

/** A quiet, short low-tone shimmer when a grave inscription is discovered. */
export function playGraveDiscovery() {
  if (status !== 'on') return
  ensureEffects()
  if (!effectContext || !effectMaster || effectContext.state !== 'running') return
  const now = effectContext.currentTime
  const voice = (frequency: number, level: number) => {
    const osc = effectContext!.createOscillator()
    const gain = effectContext!.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(frequency, now)
    osc.frequency.exponentialRampToValueAtTime(frequency * 0.82, now + 1.15)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(level, now + 0.16)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.35)
    osc.connect(gain)
    gain.connect(effectMaster!)
    osc.start(now)
    osc.stop(now + 1.4)
  }
  voice(74, 0.022)
  voice(111, 0.008)
}

/** Low, restrained pressure tone for the central grave's discovery beat. */
export function playMainGraveRumble() {
  if (status !== 'on') return
  ensureEffects()
  if (!effectContext || !effectMaster || effectContext.state !== 'running') return
  const now = effectContext.currentTime
  const osc = effectContext.createOscillator()
  const sub = effectContext.createOscillator()
  const filter = effectContext.createBiquadFilter()
  const gain = effectContext.createGain()
  osc.type = 'sine'
  sub.type = 'sine'
  osc.frequency.setValueAtTime(52, now)
  osc.frequency.exponentialRampToValueAtTime(43, now + 3.6)
  sub.frequency.setValueAtTime(26, now)
  sub.frequency.exponentialRampToValueAtTime(22, now + 3.6)
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(115, now)
  filter.Q.value = 0.8
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.038, now + 0.5)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 4.1)
  osc.connect(filter); sub.connect(filter); filter.connect(gain); gain.connect(effectMaster)
  osc.start(now); sub.start(now)
  osc.stop(now + 4.2); sub.stop(now + 4.2)
}

/** A sparse synthesized feline cry, filtered and kept distant in the mix. */
export function playDistantCat() {
  if (status !== 'on') return
  ensureEffects()
  if (!effectContext || !effectMaster || effectContext.state !== 'running') return

  const now = effectContext.currentTime
  const pitch = 0.88 + Math.random() * 0.25
  const oscillator = effectContext.createOscillator()
  const formant = effectContext.createBiquadFilter()
  const envelope = effectContext.createGain()
  oscillator.type = 'sawtooth'
  oscillator.frequency.setValueAtTime(510 * pitch, now)
  oscillator.frequency.exponentialRampToValueAtTime(720 * pitch, now + 0.36)
  oscillator.frequency.exponentialRampToValueAtTime(390 * pitch, now + 1.38)
  formant.type = 'bandpass'
  formant.Q.value = 2.2
  formant.frequency.setValueAtTime(920, now)
  formant.frequency.exponentialRampToValueAtTime(640, now + 1.25)
  envelope.gain.setValueAtTime(0.0001, now)
  envelope.gain.exponentialRampToValueAtTime(0.026, now + 0.12)
  envelope.gain.setValueAtTime(0.017, now + 0.52)
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + 1.52)
  oscillator.connect(formant)
  formant.connect(envelope)
  envelope.connect(effectMaster)
  oscillator.start(now)
  oscillator.stop(now + 1.56)
}

export function playGateCreak() {
  ensure()
  if (status === 'muted') return
  creak!.preload = 'auto'
  if (status === 'locked') {
    // Remember it; if the user clicks/keys shortly after we still play it.
    creakPending = true
    // Try anyway — works if the page already has sticky user activation.
    void creak!
      .play()
      .then(() => {
        creakPending = false
        status = 'on'
        emit()
        startAmbience()
      })
      .catch(() => undefined)
    return
  }
  creak!.currentTime = 0
  void creak!.play().catch(() => undefined)
}

export function stopGateCreak(fadeSeconds = 0.8) {
  if (!creak) return
  creakPending = false
  gsap.to(creak, {
    volume: 0,
    duration: fadeSeconds,
    onComplete: () => {
      creak?.pause()
      if (creak) creak.volume = CREAK_VOLUME
    },
  })
}

/** Gentle swell of the ambience as the visitor crosses the threshold. */
export function swellAmbience(level: number) {
  if (!ambience || status !== 'on') return
  gsap.to(ambience, { volume: AMBIENT_VOLUME * level, duration: 3, ease: 'sine.inOut', overwrite: true })
}

/** Ease the bed out as the visitor leaves the cemetery. */
export function fadeAmbience(duration = 12) {
  if (!ambience || status !== 'on') return
  gsap.killTweensOf(ambience)
  gsap.to(ambience, { volume: 0, duration, ease: 'sine.inOut', onComplete: () => ambience?.pause() })
}
