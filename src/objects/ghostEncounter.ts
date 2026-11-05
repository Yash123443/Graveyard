export interface GhostEncounter { elapsed: number; opacity: number; retreat: number; previousDistance: number; gone: boolean }
export const newGhostEncounter = (): GhostEncounter => ({ elapsed: 0, opacity: 0, retreat: 0, previousDistance: Infinity, gone: false })

/** A short peek, then retreat on approach or deliberate inspection. Gone means gone for this visit. */
export function updateGhostEncounter(state: GhostEncounter, delta: number, distance: number, gaze: number, enabled: boolean, index: number) {
  const dt = Math.max(0, Math.min(delta, 0.05))
  state.elapsed += enabled ? dt : 0
  const window = (state.elapsed + index * 3.7) % (14 + index * 2)
  const peeking = enabled && distance > 8 && distance < 30 && window > 2 && window < 6
  const closing = Number.isFinite(state.previousDistance) && (state.previousDistance - distance) / Math.max(dt, 0.001) > 0.6
  if (state.opacity > 0.08 && (closing || gaze > 0.985)) state.retreat += dt
  else state.retreat = Math.max(0, state.retreat - dt * 0.5)
  if (enabled && (distance <= 8 || state.retreat >= 0.45)) state.gone = true
  const target = peeking && !state.gone ? 0.66 : 0
  state.opacity += (target - state.opacity) * (1 - Math.exp(-dt * (state.gone ? 12 : 3)))
  // Never let an observer get close enough to examine the apparition.
  if (distance < 6.5) state.opacity = 0
  state.previousDistance = distance
  return state
}
