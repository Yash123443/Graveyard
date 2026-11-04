import * as THREE from 'three'

type SoulVariant = 'analyst' | 'fixer' | 'tester'

interface SoulOptions {
  variant?: SoulVariant
  rotY?: number
  scale?: number
  lightIntensity?: number
  lightDistance?: number
}

const palette: Record<SoulVariant, { accent: number; robe: number; face: number }> = {
  analyst: { accent: 0x9d55ff, robe: 0x17121f, face: 0x8d6b9e },
  fixer: { accent: 0xff4b38, robe: 0x211413, face: 0x9e665d },
  tester: { accent: 0x56e7a1, robe: 0x10231c, face: 0x6da78b },
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smooth = (v: number) => { const t = clamp01(v); return t * t * (3 - 2 * t) }

function mat(color: number, roughness = 0.82) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02, transparent: true, opacity: 0 })
}

function addHand(parent: THREE.Group, material: THREE.Material, side: number) {
  const hand = new THREE.Group()
  hand.position.set(side * 0.48, 0.78, 0.1)
  hand.rotation.z = side * -0.08
  const palm = new THREE.Mesh(new THREE.SphereGeometry(0.11, 18, 12), material)
  palm.scale.set(0.75, 1.18, 0.62)
  hand.add(palm)
  for (let i = 0; i < 4; i += 1) {
    const finger = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.11, 5, 8), material)
    finger.position.set(side * (0.04 + i * 0.027), -0.12, 0.02)
    finger.rotation.z = side * (0.12 + i * 0.04)
    hand.add(finger)
  }
  parent.add(hand)
  return hand
}

export function createWitchSoul(parent: THREE.Group, options: SoulOptions = {}) {
  const variant = options.variant ?? 'analyst'
  const colors = palette[variant]
  const accent = new THREE.Color(colors.accent)
  const root = new THREE.Group()
  root.rotation.y = options.rotY ?? 0
  root.scale.setScalar(options.scale ?? 1)
  parent.add(root)

  const body = new THREE.Group()
  root.add(body)

  const robe = mat(colors.robe, 0.92)
  const robeLight = mat(new THREE.Color(colors.robe).multiplyScalar(1.8).getHex(), 0.88)
  const face = mat(colors.face, 0.62)
  const skinDark = mat(new THREE.Color(colors.face).multiplyScalar(0.48).getHex(), 0.9)
  const boot = mat(0x07070b, 0.96)
  const voidMaterial = new THREE.MeshStandardMaterial({ color: 0x09070b, roughness: 1, transparent: true, opacity: 0 })
  const accentMaterial = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1.8, roughness: 0.42, transparent: true, opacity: 0 })
  const glowMaterial = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })

  const skirt = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.65, 40, 10, true), robe)
  skirt.position.y = 0.72
  skirt.castShadow = true
  skirt.receiveShadow = true
  body.add(skirt)

  const frontPanel = new THREE.Mesh(new THREE.ConeGeometry(0.43, 1.3, 24, 6, true), robeLight)
  frontPanel.position.set(0, 0.82, 0.19)
  frontPanel.scale.set(0.62, 1, 0.28)
  body.add(frontPanel)

  const belt = new THREE.Mesh(new THREE.TorusGeometry(0.39, 0.035, 8, 48), robeLight)
  belt.rotation.x = Math.PI / 2
  belt.position.y = 1.18
  body.add(belt)

  const mantle = new THREE.Mesh(new THREE.SphereGeometry(0.7, 40, 20), robeLight)
  mantle.scale.set(1.25, 0.38, 0.78)
  mantle.position.y = 1.48
  mantle.castShadow = true
  body.add(mantle)

  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.46, 0.64, 32, 8), robe)
  torso.position.y = 1.34
  body.add(torso)

  const leftSleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.52, 8, 16), robe)
  const rightSleeve = leftSleeve.clone()
  leftSleeve.position.set(-0.38, 1.17, 0)
  rightSleeve.position.set(0.38, 1.17, 0)
  leftSleeve.rotation.z = -0.48
  rightSleeve.rotation.z = 0.48
  body.add(leftSleeve, rightSleeve)
  const leftHand = addHand(body, face, -1)
  const rightHand = addHand(body, face, 1)

  const leftBoot = new THREE.Mesh(new THREE.SphereGeometry(0.19, 18, 12), boot)
  const rightBoot = leftBoot.clone()
  leftBoot.scale.set(0.7, 0.42, 1.3)
  rightBoot.scale.copy(leftBoot.scale)
  leftBoot.position.set(-0.24, -0.07, 0.2)
  rightBoot.position.set(0.24, -0.07, 0.2)
  body.add(leftBoot, rightBoot)

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.22, 20), face)
  neck.position.y = 1.76
  body.add(neck)

  const head = new THREE.Group()
  head.position.set(0, 1.98, 0.04)
  body.add(head)
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.31, 40, 28), face)
  headMesh.scale.set(0.88, 1.14, 0.84)
  headMesh.castShadow = true
  head.add(headMesh)

  // Hood is a shell behind the face, so the face remains a readable human form.
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.48, 40, 28), robe)
  hood.scale.set(1.13, 1.18, 0.62)
  hood.position.set(0, 0.02, -0.2)
  hood.castShadow = true
  head.add(hood)
  const hoodBrim = new THREE.Mesh(new THREE.TorusGeometry(0.39, 0.075, 10, 48), robeLight)
  hoodBrim.rotation.x = Math.PI / 2
  hoodBrim.position.set(0, -0.22, 0.06)
  hoodBrim.scale.set(1.12, 0.72, 1)
  head.add(hoodBrim)

  const socketMaterial = new THREE.MeshStandardMaterial({ color: 0x050407, roughness: 1, transparent: true, opacity: 0 })
  const socketL = new THREE.Mesh(new THREE.SphereGeometry(0.065, 16, 10), socketMaterial)
  const socketR = socketL.clone()
  socketL.scale.set(1.25, 0.55, 0.25)
  socketR.scale.copy(socketL.scale)
  socketL.position.set(-0.105, 0.035, 0.305)
  socketR.position.set(0.105, 0.035, 0.305)
  head.add(socketL, socketR)

  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.023, 12, 8), accentMaterial)
  const eyeR = eyeL.clone()
  eyeL.scale.set(1.25, 0.48, 0.35)
  eyeR.scale.copy(eyeL.scale)
  eyeL.position.set(-0.105, 0.035, 0.33)
  eyeR.position.set(0.105, 0.035, 0.33)
  head.add(eyeL, eyeR)

  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.048, 12, 8), skinDark)
  nose.scale.set(0.7, 1.45, 0.7)
  nose.position.set(0, -0.04, 0.32)
  head.add(nose)
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.018, 0.012), skinDark)
  mouth.position.set(0, -0.15, 0.31)
  head.add(mouth)

  const chestOrb = new THREE.Mesh(new THREE.SphereGeometry(0.115, 24, 16), accentMaterial)
  chestOrb.position.set(0, 1.42, 0.43)
  body.add(chestOrb)
  const chestHalo = new THREE.Mesh(new THREE.SphereGeometry(0.28, 20, 14), glowMaterial)
  chestHalo.position.copy(chestOrb.position)
  body.add(chestHalo)
  const glow = new THREE.PointLight(accent, 0, options.lightDistance ?? 9, 2)
  glow.position.set(0, 1.5, 0.5)
  body.add(glow)

  const capeTrails = [-1, 0, 1].map((side) => {
    const trail = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.45, 10, 6, true), robeLight)
    trail.position.set(side * 0.3, 0.55, -0.34 - Math.abs(side) * 0.08)
    trail.rotation.z = side * 0.26
    trail.rotation.x = -0.18
    trail.scale.set(0.7, 1, 0.42)
    body.add(trail)
    return trail
  })

  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.012, 8, 64), glowMaterial)
  ring.rotation.x = Math.PI / 2
  ring.position.y = 0.58
  body.add(ring)

  const particlePositions = new Float32Array(160 * 3)
  for (let i = 0; i < 160; i += 1) {
    const a = i * 2.41
    const radius = 0.35 + (i % 13) / 13 * 0.85
    particlePositions[i * 3] = Math.cos(a) * radius
    particlePositions[i * 3 + 1] = 0.18 + (i % 23) / 23 * 2.15
    particlePositions[i * 3 + 2] = Math.sin(a) * radius * 0.48 - 0.15
  }
  const particlesGeometry = new THREE.BufferGeometry()
  particlesGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3))
  const particlesMaterial = new THREE.PointsMaterial({ color: accent, size: 0.022, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
  const particles = new THREE.Points(particlesGeometry, particlesMaterial)
  body.add(particles)

  const fadeMaterials = [robe, robeLight, face, skinDark, boot, voidMaterial, accentMaterial, socketMaterial, glowMaterial, particlesMaterial]
  let timeline = 0
  let elapsed = 0
  let pose = 0
  const set = (T: number, time: number, targetPose = 1, fade = 1) => {
    timeline = T
    elapsed = time
    pose += (targetPose - pose) * 0.05
    const appear = smooth((T - 4.8) / 4.5) * fade
    fadeMaterials.forEach((material) => { material.opacity = appear * (material === particlesMaterial ? 0.38 : 1) })
    glow.intensity = appear * (options.lightIntensity ?? 1.15)
    body.position.y = (1 - appear) * -0.18 + Math.sin(time * 0.8) * 0.018
    body.rotation.y = Math.sin(time * 0.25) * 0.025
    body.rotation.z = Math.sin(time * 0.7) * 0.008
    leftHand.rotation.x = -0.1 - pose * 0.15 + Math.sin(time * 0.7) * 0.02
    rightHand.rotation.x = -0.1 - pose * 0.15 + Math.cos(time * 0.65) * 0.02
    chestHalo.scale.setScalar(0.9 + Math.sin(time * 1.6) * 0.08)
    ring.rotation.z = time * 0.35
    capeTrails.forEach((trail, i) => {
      trail.rotation.y = Math.sin(time * 0.45 + i) * 0.12
      trail.rotation.z = Math.cos(time * 0.3 + i) * 0.035
    })
    particles.rotation.y = time * 0.06
    eyeL.scale.y = eyeR.scale.y = 0.38 + Math.abs(Math.sin(time * 2.1)) * 0.2
    root.visible = appear > 0.003
    return appear
  }

  return {
    group: root,
    set,
    update(dt: number) { timeline += dt; elapsed += dt; return set(timeline, elapsed, 1, 1) },
    setPixelRatio(_ratio: number) {},
    dispose() {
      root.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const material = mesh.material
        if (material) (Array.isArray(material) ? material : [material]).forEach((item) => item.dispose())
      })
      parent.remove(root)
    },
  }
}
