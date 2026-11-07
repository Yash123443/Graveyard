/** Keep the three performers within the horizontal field of view on portrait displays. */
export function ritualCameraDistance(aspect: number, fov = 53) {
  const halfWidth = 6.4
  return Math.max(14.5, halfWidth / (Math.tan(fov * Math.PI / 360) * Math.max(0.25, aspect)))
}
