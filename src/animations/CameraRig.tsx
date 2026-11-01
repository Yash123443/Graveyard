import { useFrame } from '@react-three/fiber'
import { useMemo } from 'react'
import * as THREE from 'three'
import { cameraLimit, seq, smoothstep } from './sequence'
import { CEMETERY_CENTER_Z, CEMETERY_ROAM_RADIUS } from '../objects/CircularCemeteryFence'

/**
 * The camera is on a rail. Scroll scrubs along it, but the rail is critically
 * damped (so it glides rather than jumps) and capped by the gate: the camera
 * cannot pass the threshold until the leaves have swung clear.
 */
export function CameraRig() {
  const { position, look } = useMemo(
    () => ({
      position: new THREE.CatmullRomCurve3(
        [
          new THREE.Vector3(0, 2.15, 34),
          new THREE.Vector3(0, 2.15, 21),
          new THREE.Vector3(0, 2.15, 10),
          new THREE.Vector3(0, 2.15, -1),
          new THREE.Vector3(0, 2.15, -9),
          new THREE.Vector3(0, 2.15, -22),
          new THREE.Vector3(0, 2.15, -43),
          new THREE.Vector3(0, 2.15, -54),
          new THREE.Vector3(0, 2.15, -65),
          new THREE.Vector3(0, 2.15, -72),
        ],
        false,
        'centripetal',
      ),
      look: new THREE.CatmullRomCurve3(
        [
          new THREE.Vector3(0, 8.4, -8),
          new THREE.Vector3(0, 7.9, -8),
          new THREE.Vector3(0, 6.8, -9),
          new THREE.Vector3(0, 6.0, -12),
          new THREE.Vector3(0, 5.0, -30),
          new THREE.Vector3(0.6, 5.5, -45),
          new THREE.Vector3(0, 4.5, -57),
          new THREE.Vector3(0, 4.4, -74),
          new THREE.Vector3(0, 5.1, -84),
        ],
        false,
        'centripetal',
      ),
    }),
    [],
  )

  const p = useMemo(() => new THREE.Vector3(), [])
  const l = useMemo(() => new THREE.Vector3(), [])
  const smoothedLook = useMemo(() => new THREE.Vector3(0, 8.4, -8), [])
  const direction = useMemo(() => new THREE.Vector3(), [])
  const lookTarget = useMemo(() => new THREE.Vector3(), [])
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), [])
  const finalShotPosition = useMemo(() => new THREE.Vector3(0, 2.9, -69.5), [])
  const finalShotLook = useMemo(() => new THREE.Vector3(0, 3.25, -83), [])

  useFrame(({ camera, clock }, delta) => {
    const dt = Math.min(delta, 0.05)
    const target = seq.exploration.entered ? 0.54 : Math.min(seq.scroll, cameraLimit())
    seq.cam += (target - seq.cam) * (1 - Math.exp(-dt * 1.6))
    // Entering free-roam used to replace the smoothed rail progress with 0.54
    // in a single frame. Keep sampling `seq.cam` so the passage through the
    // gate remains one continuous camera move.
    const t = Math.min(1, Math.max(0, seq.cam - seq.ending.cameraBack * 0.27))
    position.getPoint(t, p)
    look.getPoint(t, l)

    const roam = seq.roam
    // Let the visitor take control as soon as the gate opening gives a safe
    // passage. Waiting for the last few degrees made the controls feel dead.
    if (!seq.exploration.entered && seq.scroll >= 0.26 && seq.gateOpen > 0.45) {
      seq.exploration.entered = true
    }
    const roamAllowed = seq.exploration.entered ? 1 : 0
    const isClear = (offsetX: number, offsetZ: number) => {
      const x = p.x + offsetX
      const z = p.z + offsetZ
      // A round collision limit mirrors the iron fence enclosing the grounds.
      return Math.hypot(x, z - CEMETERY_CENTER_Z) < CEMETERY_ROAM_RADIUS
        && !seq.exploration.obstacles.some((obstacle) => Math.hypot(x - obstacle.x, z - obstacle.z) < obstacle.radius + 0.72)
    }
    if (roamAllowed > 0) {
      const forward = Number(roam.input.forward) - Number(roam.input.back)
      const strafe = Number(roam.input.right) - Number(roam.input.left)
      const turn = Number(roam.input.turnRight) - Number(roam.input.turnLeft)
      roam.targetYaw += turn * dt * 1.2
      const speed = 5.5 * dt
      const nextX = roam.targetX + (strafe * Math.cos(roam.yaw) + forward * Math.sin(roam.yaw)) * speed
      const nextZ = roam.targetZ + (strafe * Math.sin(roam.yaw) - forward * Math.cos(roam.yaw)) * speed
      if (isClear(nextX, roam.targetZ)) roam.targetX = nextX
      if (isClear(roam.targetX, nextZ)) roam.targetZ = nextZ
    }
    if (!isClear(roam.targetX, roam.targetZ)) {
      roam.targetX = roam.x
      roam.targetZ = roam.z
    }
    roam.x += (roam.targetX - roam.x) * (1 - Math.exp(-dt * 5))
    roam.z += (roam.targetZ - roam.z) * (1 - Math.exp(-dt * 5))
    roam.yaw += (roam.targetYaw - roam.yaw) * (1 - Math.exp(-dt * 5))
    roam.pitch += (roam.targetPitch - roam.pitch) * (1 - Math.exp(-dt * 5))

    // during scene 1 the camera creeps forward out of the dark
    const introCreep = (1 - seq.reveal.gate) * 3
    const time = clock.elapsedTime
    const moving = smoothstep(0, 0.06, t)
    // handheld breathing — stronger once the visitor is walking
    const swayX = Math.sin(time * 0.37) * 0.05 + Math.sin(time * 1.1) * 0.012 * moving
    const swayY = Math.sin(time * 0.53 + 1) * 0.035 + Math.sin(time * 1.9) * 0.01 * moving

    const freeX = THREE.MathUtils.lerp(p.x + roam.x, 0, seq.ending.cameraBack)
    const freeZ = THREE.MathUtils.lerp(p.z + roam.z, 34, seq.ending.cameraBack)
    camera.position.set(roamAllowed ? freeX + swayX : p.x + swayX + seq.pointer.x * 0.15, 2.15 + swayY + seq.pointer.y * 0.08 * (1 - roamAllowed), roamAllowed ? freeZ : p.z + introCreep)

    l.y = THREE.MathUtils.lerp(l.y, 2.15, smoothstep(0.2, 0.4, t))
    smoothedLook.lerp(l, 1 - Math.exp(-dt * 3))
    if (roamAllowed) {
      direction.set(Math.sin(roam.yaw), Math.sin(roam.pitch), -Math.cos(roam.yaw))
      if (seq.ending.cameraBack > 0) {
        l.set(0, 4.5, 20).sub(camera.position).normalize()
        direction.lerp(l, seq.ending.cameraBack).normalize()
      }
    }
    else direction.subVectors(smoothedLook, camera.position).applyAxisAngle(up, roam.yaw * roamAllowed)
    const storyShot = smoothstep(0.01, 0.1, seq.exploration.storyProgress) * (1 - seq.ending.cameraBack)
    if (storyShot > 0) camera.position.lerp(finalShotPosition, storyShot)
    lookTarget.copy(camera.position).add(direction)
    if (storyShot > 0) lookTarget.lerp(finalShotLook, storyShot)
    camera.lookAt(lookTarget.x + seq.pointer.x * 0.32, lookTarget.y + seq.pointer.y * 0.18, lookTarget.z)

    const cam = camera as THREE.PerspectiveCamera
    const fov = 46 + smoothstep(0.5, 0.75, t) * 7 // subtle widening as we pass through
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov
      cam.updateProjectionMatrix()
    }
  })

  return null
}
