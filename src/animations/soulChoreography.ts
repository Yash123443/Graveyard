export const STORY_DURATION = 36
export const SOUL_STARTS = [0, 0.24, 0.48] as const
const ease = (a: number, b: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
export function soulCue(progress: number, start: number) {
  const local = progress - start
  const entrance = ease(0, 0.065, local)
  return {
    entrance,
    // Map directly to the existing actor's materialization range; no invisible pre-roll.
    actorTime: 4.8 + entrance * 4.5,
    caption: ease(0.035, 0.07, local) * (1 - ease(0.215, 0.24, local)),
  }
}
export function advanceStoryProgress(progress: number, delta: number) {
  return Math.min(1, progress + Math.max(0, Math.min(delta, 0.05)) / STORY_DURATION)
}
