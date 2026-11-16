import { atmosphereSettings } from '../objects/WaxCandle'
import * as THREE from 'three'

/** Open orb webs with distinct radial supports and gently scalloped silk rings. */
export function createCobwebGeometry(seed = 0, radius = 1) {
  const points: number[] = [], colors: number[] = []
  const random = (n: number) => { const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453; return x - Math.floor(x) }
  const center = new THREE.Vector3(-0.16 * radius, 0.07 * radius, 0.08 * radius)
  const spokes = Math.max(8, Math.min(12, atmosphereSettings.webDensity))
  const anchors = Array.from({ length: spokes }, (_, i) => {
    const a = i / spokes * Math.PI * 2 + (random(i) - 0.5) * 0.06
    const reach = radius * (0.92 + random(i + 20) * 0.16)
    return new THREE.Vector3(Math.cos(a) * reach, Math.sin(a) * reach * 0.82, (random(i + 40) - 0.5) * radius * 0.16)
  })
  const thread = (a: THREE.Vector3, b: THREE.Vector3, sag: number, strength: number) => {
    let previous = a.clone()
    for (let step = 1; step <= 7; step++) {
      const t = step / 7, next = a.clone().lerp(b, t)
      next.y -= Math.sin(t * Math.PI) * sag
      next.z += Math.sin(t * Math.PI) * sag * 0.35
      points.push(...previous.toArray(), ...next.toArray())
      for (let j = 0; j < 2; j++) colors.push(strength * 0.78, strength * 0.88, strength)
      previous = next
    }
  }
  anchors.forEach((anchor, i) => {
    thread(center, anchor, 0, 0.8)
    if (i % 3 === 0) thread(anchor, anchor.clone().multiplyScalar(1.35 + random(i + 5) * 0.3), radius * 0.09, 0.48)
  })
  for (let turn = 1; turn <= 13; turn++) for (let i = 0; i < spokes; i++) {
    // Sparse damage only at the edge; intact rings make the silk structure readable.
    if (turn > 3 && random(turn * 97 + i + 61) < 0.055) continue
    const t = (turn + (random(turn + 90) - 0.5) * 0.35) / 14
    const a = center.clone().lerp(anchors[i], t)
    const b = center.clone().lerp(anchors[(i + 1) % spokes], t)
    const mid = a.clone().lerp(b, 0.5).lerp(center, 0.12)
    let previous = a
    for (let step = 1; step <= 6; step++) {
      const u = step / 6
      const next = a.clone().multiplyScalar((1-u)*(1-u)).addScaledVector(mid, 2*u*(1-u)).addScaledVector(b, u*u)
      points.push(...previous.toArray(), ...next.toArray())
      const strength = 0.27 + random(turn * 17 + i) * 0.3
      for (let j = 0; j < 2; j++) colors.push(strength * 0.88, strength * 0.94, strength)
      previous = next
    }
  }
  // Tiny irregular silk knots share the strand draw call.
  for(let i=0;i<spokes;i+=3) {
    const knot=center.clone().lerp(anchors[i],.35+random(i+180)*.4)
    const r=radius*.007
    thread(knot.clone().add(new THREE.Vector3(-r,0,0)),knot.clone().add(new THREE.Vector3(r,r,0)),0,.8)
    thread(knot.clone().add(new THREE.Vector3(0,-r,0)),knot.clone().add(new THREE.Vector3(0,r,0)),0,.65)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.computeBoundingSphere()
  return geometry
}
