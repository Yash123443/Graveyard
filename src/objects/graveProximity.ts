export interface ProximityTarget {
  x: number
  z: number
  enterRadius: number
  exitRadius: number
}

/**
 * Finds one active target from planar camera distance. The exit range is wider
 * than the enter range, and a new target must be meaningfully closer before it
 * replaces the current one. This keeps nearby plots from flickering together.
 */
export function selectNearestProximity<T extends ProximityTarget>(targets: readonly T[], x: number, z: number, activeIndex: number) {
  const distanceTo = (target: T) => Math.hypot(x - target.x, z - target.z)
  let candidate = -1
  let candidateDistance = Number.POSITIVE_INFINITY

  targets.forEach((target, index) => {
    const distance = distanceTo(target)
    if (distance <= target.enterRadius && distance < candidateDistance) {
      candidate = index
      candidateDistance = distance
    }
  })

  if (activeIndex < 0 || !targets[activeIndex]) return candidate
  const activeDistance = distanceTo(targets[activeIndex])
  if (activeDistance > targets[activeIndex].exitRadius) return candidate

  // Retain the current plot around overlapping edges unless the newcomer is
  // visibly closer. This is direction independent and avoids panel thrashing.
  if (candidate >= 0 && candidate !== activeIndex && candidateDistance + 0.85 < activeDistance) return candidate
  return activeIndex
}
