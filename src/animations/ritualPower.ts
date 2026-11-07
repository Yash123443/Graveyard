const ease = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
export function ritualPower(index: number, story: number, ending: number, outcome: string, endingStarted: boolean) {
  const start = index * 0.24
  const individual = ease(start + 0.1, start + 0.14, story) * (1 - ease(start + 0.19, start + 0.23, story))
  const combined = ease(0.72 + index * 0.055, 0.79 + index * 0.055, story)
  if (!endingStarted) return Math.max(individual * 0.65, combined)
  if (outcome !== 'success') return combined * (1 - ease(0, 0.2, ending))
  return Math.max(combined * (1 - ease(0.35, 0.55, ending)), ease(0.12 + index * 0.08, 0.2 + index * 0.08, ending) * (1 - ease(0.5, 0.65, ending)))
}
