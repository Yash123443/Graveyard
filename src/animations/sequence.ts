import gsap from 'gsap'
import { fadeAmbience, getCreakDuration, playGateCreak, stopGateCreak, swellAmbience } from '../audio/audioManager'
import { getRepairResult, isVerifiedRepair, RepairResult } from '../integrations/repairResult'

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * Single mutable store shared by the 3D scene and the DOM overlay.
 * It is deliberately NOT React state: values change every frame and are
 * read inside useFrame / requestAnimationFrame, so nothing re-renders.
 */
export const seq = {
  /** Scene 1 — each element fades up out of darkness in its own time. */
  reveal: { veil: 1, light: 0, moon: 0, clouds: 0, trees: 0, fog: 0, gate: 0, stars: 0 },
  introDone: false,
  /** Scene 2 — user scroll intent (target) and its GSAP-smoothed value. */
  scrollTarget: 0,
  scroll: 0,
  /** 0 closed → 1 fully open. Driven by a timed tween, synced to the creak. */
  gateOpen: 0,
  /** Camera progress actually applied (scroll limited by the gate). */
  cam: 0,
  /** Bat flocks launched so far (bats subscribe via this counter). */
  flock: { id: 0, a: false, b: false },
  pointer: { x: 0, y: 0 },
  roam: {
    x: 0, z: 0, yaw: 0, pitch: 0,
    targetX: 0, targetZ: 0, targetYaw: 0, targetPitch: 0,
    input: { forward: false, back: false, left: false, right: false, turnLeft: false, turnRight: false },
  },
  exploration: { nearGrave: -1, nearMain: 0, entered: false, storyProgress: 0, storyStarted: false, obstacles: [] as { x: number; z: number; radius: number }[] },
  ending: {
    started: false,
    outcome: 'pending' as 'pending' | 'success' | 'failure',
    progress: 0,
    gather: 0,
    cameraBack: 0,
    fogFade: 0,
    moonFade: 0,
  },
}

if (import.meta.env.DEV) (window as unknown as { __seq: typeof seq; __gsap: typeof gsap }).__seq = seq
if (import.meta.env.DEV) (window as unknown as { __gsap: typeof gsap }).__gsap = gsap

let introTimeline: gsap.core.Timeline | null = null
let gateTween: gsap.core.Tween | null = null
let gateState: 'closed' | 'opening' | 'open' | 'closing' = 'closed'
let endingTimeline: gsap.core.Timeline | null = null
let endingFallback: gsap.core.Tween | null = null
const introListeners = new Set<() => void>()
export const onIntroEvent = (fn: () => void) => {
  introListeners.add(fn)
  return () => introListeners.delete(fn)
}

function playEnding(result: RepairResult | null) {
  if (!seq.ending.started || seq.ending.outcome !== 'pending') return
  const success = isVerifiedRepair(result)
  seq.ending.outcome = success ? 'success' : 'failure'
  endingFallback?.kill()
  endingTimeline?.kill()
  const e = seq.ending
  fadeAmbience(14)
  endingTimeline = gsap.timeline()
  if (success) {
    // Three agents gather, release their colors in turn, and fuse into the grave.
    endingTimeline.to(e, { gather: 1, duration: 3.8, ease: 'power2.inOut' }, 0)
    endingTimeline.to(e, { progress: 0.22, duration: 3, ease: 'sine.inOut' }, 1)
    endingTimeline.to(e, { progress: 0.42, duration: 3.6, ease: 'power1.inOut' }, 3.2)
    endingTimeline.to(e, { progress: 0.58, duration: 2.6, ease: 'power2.inOut' }, 6.6)
    endingTimeline.to(e, { progress: 0.72, duration: 2.6, ease: 'power2.inOut' }, 9.2)
    endingTimeline.to(e, { progress: 0.86, duration: 2.8, ease: 'power3.in' }, 11.8)
    endingTimeline.to(e, { progress: 1, duration: 2.8, ease: 'power1.inOut' }, 14.6)
  } else {
    // Failure is quiet and explicit: no shaking, opening, or resurrection light.
    endingTimeline.to(e, { gather: 0.5, duration: 2.2, ease: 'power2.inOut' }, 0)
    endingTimeline.to(e, { progress: 0.24, duration: 4.2, ease: 'sine.inOut' }, 0)
    endingTimeline.to(e, { progress: 0.62, duration: 6, ease: 'sine.inOut' }, 4.2)
    endingTimeline.to(e, { progress: 1, duration: 7, ease: 'power1.inOut' }, 10.2)
  }
  endingTimeline.to(e, { cameraBack: 1, duration: 13, ease: 'sine.inOut' }, success ? 8 : 4)
  endingTimeline.to(e, { fogFade: 1, duration: 5, ease: 'sine.inOut' }, success ? 13 : 8)
  endingTimeline.to(e, { moonFade: 1, duration: 7, ease: 'sine.inOut' }, success ? 17 : 13)
}

function beginEnding() {
  if (seq.ending.started) return
  seq.ending.started = true
  seq.ending.outcome = 'pending'
  if (getRepairResult()) playEnding(getRepairResult())
  else {
    // Give an already-running backend job a short window to publish its result.
    endingFallback = gsap.delayedCall(4.5, () => playEnding(getRepairResult()))
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('graveyard:repair-result-accepted', () => {
    if (seq.ending.started && seq.ending.outcome === 'pending') playEnding(getRepairResult())
  })
}

/* ------------------------------------------------------------------ */
/*  SCENE 1 — out of the darkness                                      */
/* ------------------------------------------------------------------ */

export function playIntro(dom: { title: HTMLElement | null; tagline: HTMLElement | null; supporting: HTMLElement | null; cue: HTMLElement | null; chrome: HTMLElement | null }) {
  const r = seq.reveal
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const tl = gsap.timeline({
    defaults: { ease: 'sine.inOut' },
    onComplete: () => {
      seq.introDone = true
      introListeners.forEach((fn) => fn())
      if (seq.scrollTarget > 0) glideScroll()
    },
  })
  introTimeline = tl

  // 0. almost total darkness — the veil lifts only a little
  tl.to(r, { veil: 0.9, duration: 1.2 }, 0)
  // 1. the gigantic moon surfaces first
  tl.to(r, { moon: 1, stars: 1, duration: 5.5, ease: 'power2.inOut' }, 1.0)
  tl.to(r, { veil: 0.62, duration: 5, ease: 'power1.inOut' }, 1.4)
  // 2. clouds drift into the moonlight
  tl.to(r, { clouds: 1, duration: 5, ease: 'power1.inOut' }, 3.2)
  // moonlight begins to touch the world
  tl.to(r, { light: 1, duration: 8, ease: 'power1.inOut' }, 4.4)
  // 3. dead trees emerge as silhouettes
  tl.to(r, { trees: 1, duration: 4.5, ease: 'power1.inOut' }, 5.6)
  // 4. fog crawls across the ground
  tl.to(r, { fog: 1, duration: 5, ease: 'power1.inOut' }, 7.0)
  // 5. the rusted iron gate takes shape
  tl.to(r, { gate: 1, duration: 4.5, ease: 'power2.inOut' }, 8.6)
  tl.to(r, { veil: 0, duration: 6, ease: 'power1.inOut' }, 8.0)

  // typography
  if (dom.chrome) tl.fromTo(dom.chrome, { opacity: 0 }, { opacity: 1, duration: 2 }, 10.5)
  if (dom.title) {
    tl.fromTo(
      dom.title,
      { opacity: 0, letterSpacing: '0.9em', filter: 'blur(14px)' },
      { opacity: 1, letterSpacing: '0.34em', filter: 'blur(0px)', duration: 3.6, ease: 'power3.out' },
      10.6,
    )
  }
  if (dom.tagline) tl.fromTo(dom.tagline, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 2.2, ease: 'power2.out' }, 12.4)
  if (dom.supporting) tl.fromTo(dom.supporting, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 2.4, ease: 'power2.out' }, 13.6)
  if (dom.cue) tl.fromTo(dom.cue, { opacity: 0 }, { opacity: 1, duration: 2 }, 15.2)

  tl.set({}, {}, 16.2) // pad so onComplete lands after the last fade
  if (reduced) tl.timeScale(3)
  return tl
}

/** If the visitor scrolls impatiently during the intro, fast-forward it. */
export function hurryIntro() {
  if (introTimeline && !seq.introDone) {
    gsap.to(introTimeline, { timeScale: 4.5, duration: 0.6, overwrite: true })
  }
}

/* ------------------------------------------------------------------ */
/*  SCENE 2 — scroll driven journey                                    */
/* ------------------------------------------------------------------ */

const GATE_TRIGGER = 0.1
const GATE_RESET = 0.03
const FLOCK_A = 0.16
const FLOCK_B = 0.5

function openGate() {
  if (gateState === 'opening' || gateState === 'open') return
  gateState = 'opening'
  gateTween?.kill()
  playGateCreak()
  const duration = Math.min(8, Math.max(4.2, getCreakDuration(5) + 0.5))
  gateTween = gsap.to(seq, {
    gateOpen: 1,
    duration,
    ease: 'power1.inOut',
    onComplete: () => {
      gateState = 'open'
    },
  })
}

function closeGate() {
  if (gateState === 'closed' || gateState === 'closing') return
  gateState = 'closing'
  gateTween?.kill()
  stopGateCreak()
  gateTween = gsap.to(seq, {
    gateOpen: 0,
    duration: 4,
    ease: 'power2.inOut',
    onComplete: () => {
      gateState = 'closed'
    },
  })
}

function onScrollUpdate() {
  const s = seq.scroll
  if (s > GATE_TRIGGER) openGate()
  else if (s < GATE_RESET) closeGate()

  if (s > FLOCK_A && !seq.flock.a) {
    seq.flock.a = true
    seq.flock.id += 1
  }
  if (s > FLOCK_B && !seq.flock.b) {
    seq.flock.b = true
    seq.flock.id += 1
  }
  if (s < GATE_RESET) {
    seq.flock.a = false
    seq.flock.b = false
  }
  swellAmbience(0.85 + 0.15 * smoothstep(0.6, 1, s))
}

export function nudgeScroll(delta: number) {
  // The opening rail ends at the cemetery threshold. Once inside, input is
  // movement and never a shortcut to the final chapter.
  seq.scrollTarget = Math.min(0.54, clamp01(seq.scrollTarget + delta))
  if (!seq.introDone) {
    hurryIntro()
    return
  }
  glideScroll()
}

function glideScroll() {
  gsap.to(seq, {
    scroll: seq.scrollTarget,
    duration: 2.1,
    ease: 'power3.out',
    overwrite: 'auto',
    onUpdate: onScrollUpdate,
  })
}

export function startFinalGraveStory() {
  const exploration = seq.exploration
  if (exploration.storyStarted) return
  exploration.storyStarted = true
  gsap.to(exploration, {
    storyProgress: 1,
    duration: 24,
    ease: 'none',
    onComplete: beginEnding,
  })
}

export function moveRoam(dx: number, dz: number) {
  if (seq.exploration.storyStarted) return
  const r = seq.roam
  const yaw = r.targetYaw
  r.targetX = Math.max(-54, Math.min(54, r.targetX + dx * Math.cos(yaw) + dz * Math.sin(yaw)))
  r.targetZ = Math.max(-108, Math.min(38, r.targetZ - dx * Math.sin(yaw) + dz * Math.cos(yaw)))
}

export function turnRoam(yaw: number, pitch = 0) {
  if (seq.exploration.storyStarted) return
  seq.roam.targetYaw += yaw
  seq.roam.targetPitch = Math.max(-1.15, Math.min(1.15, seq.roam.targetPitch + pitch))
}

/** Camera progress can never outrun the gate: it waits for the leaves to swing clear. */
export function cameraLimit() {
  return 0.52 + 0.48 * smoothstep(0.3, 0.82, seq.gateOpen)
}
