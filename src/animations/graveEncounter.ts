export const GRAVE_READING_SECONDS = 12

/** A readable pause at the landmark, independent of refresh rate. */
export function advanceGraveReading(elapsed: number, distance: number, facing: number, speed: number, delta: number) {
  if (distance > 14.5) return 0
  if (distance > 12.5 || facing < 0.72 || speed > 1.2) return elapsed
  return Math.min(GRAVE_READING_SECONDS, elapsed + Math.max(0, Math.min(delta, 0.05)))
}
