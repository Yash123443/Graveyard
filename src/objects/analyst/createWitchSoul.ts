import * as THREE from 'three'
import { batchStaticMeshes } from '../../utils/batchStaticMeshes'

type SoulVariant = 'analyst' | 'fixer' | 'tester'
interface SoulOptions { variant?: SoulVariant; rotY?: number; scale?: number; lightIntensity?: number; lightDistance?: number }
const palette = { analyst: 0xa65bff, fixer: 0xff443b, tester: 0x42ee93 }
const smooth = (v: number) => { const t = THREE.MathUtils.clamp(v, 0, 1); return t * t * (3 - 2 * t) }

/** Continuous cloth surface: radial pleats, a torn hem, and asymmetric layered folds. */
function cloth(bottom: number, top: number, height: number, phase = 0, arc = Math.PI * 2) {
  const vertices: number[] = [], indices: number[] = [], uv: number[] = []
  const columns = 56, rows = 20
  for (let j = 0; j <= rows; j++) {
    const v = j / rows
    for (let i = 0; i <= columns; i++) {
      const u = i / columns, a = u * arc + phase
      const fold = Math.sin(a * 6 + v * 1.5) * 0.035 + Math.sin(a * 12 - v * 2) * 0.005
      const radius = THREE.MathUtils.lerp(bottom, top, v) + fold * (1.2 - v * 0.6)
      const torn = (Math.sin(a * 7) * 0.025 + Math.sin(a * 11 + 1) * 0.012) * Math.pow(1 - v, 6)
      vertices.push(Math.sin(a) * radius, v * height + torn, Math.cos(a) * radius * 0.72)
      uv.push(u * 4, v * 3)
      if (j < rows && i < columns) {
        const n = j * (columns + 1) + i
        indices.push(n, n + 1, n + columns + 1, n + 1, n + columns + 2, n + columns + 1)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geometry.setIndex(indices); geometry.computeVertexNormals()
  return geometry
}

function fabricTexture() {
  const size = 128, data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = (y * size + x) * 4
    const grain = 110 + Math.sin(x * 91.7 + y * 27.1) * 22 + (x % 3 === 0 ? 24 : 0) + (y % 4 === 0 ? 18 : 0)
    data[n] = data[n + 1] = data[n + 2] = grain; data[n + 3] = 255
  }
  const texture = new THREE.DataTexture(data, size, size)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.needsUpdate = true
  return texture
}

export function createWitchSoul(parent: THREE.Group, options: SoulOptions = {}) {
  const variant = options.variant ?? 'analyst', accent = new THREE.Color(palette[variant])
  const root = new THREE.Group(), body = new THREE.Group()
  root.rotation.y = options.rotY ?? 0; root.scale.setScalar(options.scale ?? 1)
  parent.add(root); root.add(body)
  const textures: THREE.Texture[] = []
  const materials: THREE.Material[] = []
  const fabric = fabricTexture(); textures.push(fabric)
  const clothTime = { value: 0 }
  const standard = (color: THREE.ColorRepresentation, roughness = 0.9) => {
    const material = new THREE.MeshStandardMaterial({ color, roughness, transparent: true, opacity: 0, side: THREE.DoubleSide, forceSinglePass: true })
    materials.push(material); return material
  }
  const robe = standard('#3b3e49'), mantle = standard('#4c505b'), lining = standard('#090b12'), bone = standard('#807b77', 0.7)
  for (const material of [robe, mantle]) {
    material.bumpMap = fabric; material.bumpScale = 0.012
    material.emissive.copy(accent); material.emissiveIntensity = 0.008
    material.onBeforeCompile = shader => {
      shader.uniforms.soulClothTime = clothTime
      shader.vertexShader = 'uniform float soulClothTime;\n' + shader.vertexShader
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        float hem = 1.0 - smoothstep(0.15, 1.8, position.y);
        transformed.x += sin(position.y * 3.0 + position.z * 4.0 + soulClothTime * 0.8) * 0.018 * hem;
        transformed.z += sin(position.x * 5.0 + soulClothTime * 0.65) * 0.014 * hem;
      `)
    }
    material.customProgramCacheKey = () => 'soul-cloth-breathing-v1'
  }
  const metal = standard('#51464b', 0.36); metal.metalness = 0.8
  const glow = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0, toneMapped: false, depthWrite: false })
  materials.push(glow)
  const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, position: [number, number, number], target: THREE.Object3D = body) => {
    const object = new THREE.Mesh(geometry, material); object.position.set(...position)
    object.castShadow = material !== glow; object.receiveShadow = material !== glow
    target.add(object); return object
  }
  const tube = (points: number[][], radius: number, material: THREE.Material, target: THREE.Object3D = body) =>
    mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p[0], p[1], p[2]))), Math.max(12, points.length * 5), radius, 5, false), material, [0, 0, 0], target)

  // A shaped torso and continuous cape establish a solid human silhouette.
  const profile = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.6, 0, 0), new THREE.Vector3(0.58, 0.35, 0),
    new THREE.Vector3(0.46, 0.85, 0), new THREE.Vector3(0.34, 1.17, 0),
    new THREE.Vector3(0.43, 1.49, 0), new THREE.Vector3(0.49, 1.65, 0),
    new THREE.Vector3(0.23, 1.82, 0),
  ])
  const torsoGeometry = new THREE.LatheGeometry(profile.getPoints(36).map(p => new THREE.Vector2(p.x, p.y)), 48)
  const torsoPositions = torsoGeometry.attributes.position
  for (let i = 0; i < torsoPositions.count; i++) {
    const x = torsoPositions.getX(i), y = torsoPositions.getY(i), z = torsoPositions.getZ(i)
    const a = Math.atan2(x, z), pleat = 1 + Math.sin(a * 8 + y * 0.6) * 0.055 + Math.sin(a * 14 - y) * 0.008
    torsoPositions.setXYZ(i, x * pleat, y, z * pleat * 0.72)
  }
  torsoGeometry.computeVertexNormals()
  mesh(torsoGeometry, robe, [0, 0, 0])
  mesh(cloth(0.72, 0.32, 1.8, 0.58, Math.PI * 2 - 1.16), mantle, [0, 0.04, -0.08])
  const shoulders = mesh(new THREE.SphereGeometry(0.5, 24, 16), mantle, [0, 1.6, -0.025])
  shoulders.scale.set(1.16, 0.3, 0.7)
  // Broad curved cloth tails replace the jagged, paper-like shoulder strips.
  const tatters: THREE.Mesh[] = []
  for (const side of [-1, 1]) {
    const tail = mesh(cloth(0.15, 0.19, 1.22, 0.3, Math.PI * 1.3), mantle, [side * 0.48, 0.38, -0.18])
    tail.rotation.z = side * 0.12
    tatters.push(tail)
  }
  // An engraved clasp and loose chain give the layered fabric a physical attachment.
  tube([[-0.31, 1.7, 0.31], [-0.18, 1.59, 0.4], [0, 1.55, 0.43], [0.18, 1.59, 0.4], [0.31, 1.7, 0.31]], 0.014, metal)
  const clasp = mesh(new THREE.OctahedronGeometry(0.07), metal, [0, 1.56, 0.45]); clasp.scale.z = 0.4
  mesh(new THREE.OctahedronGeometry(0.025), glow, [0, 1.56, 0.48])
  body.scale.x = variant === 'fixer' ? 1.12 : variant === 'analyst' ? 0.94 : 1
  for (const side of [-1, 1]) {
    const sleeve = mesh(cloth(0.21, 0.17, 0.73), robe, [side * 0.53, 1.04, 0.18])
    sleeve.rotation.z = side * 0.38; sleeve.rotation.x = -0.38
    const palm = mesh(new THREE.SphereGeometry(0.1, 16, 12), bone, [side * 0.52, 1.1, 0.56])
    palm.scale.set(1, 0.45, 1.22)
    for (let finger = 0; finger < 4; finger++) {
      const x = side * 0.52 + (finger - 1.5) * 0.042
      tube([[x, 1.1, 0.6], [x, 1.09, 0.71], [x + side * 0.015, 1.14, 0.77]], 0.017, bone)
      mesh(new THREE.SphereGeometry(0.021, 8, 6), bone, [x, 1.09, 0.69])
    }
    tube([[side * 0.44, 1.1, 0.56], [side * 0.4, 1.12, 0.65], [side * 0.43, 1.14, 0.7]], 0.022, bone)
  }

  // Open hood with a pointed crown. The opening faces +Z; no sphere covers the face.
  const hoodVertices: number[] = [], hoodIndices: number[] = [], hoodUV: number[] = []
  for (let j = 0; j <= 24; j++) for (let i = 0; i <= 64; i++) {
    const v = j / 24, a = i / 64 * Math.PI * 2
    hoodUV.push(i / 64, v)
    const arch = Math.cos(a), r = 1 - v * 0.94
    const pleat = Math.sin(a * 7 + v * 2) * 0.006
    hoodVertices.push(Math.sin(a) * (0.3 * r + pleat), 2.06 + arch * 0.43 * r + v * 0.43 + Math.max(0, arch) ** 4 * 0.08 * (1 - v), 0.26 - v * 0.62 - Math.max(0, arch) * 0.06)
    if (j < 24 && i < 64) { const n = j * 65 + i; hoodIndices.push(n, n + 65, n + 1, n + 1, n + 65, n + 66) }
  }
  const hoodGeometry = new THREE.BufferGeometry()
  hoodGeometry.setAttribute('position', new THREE.Float32BufferAttribute(hoodVertices, 3)); hoodGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(hoodUV, 2)); hoodGeometry.setIndex(hoodIndices); hoodGeometry.computeVertexNormals()
  mesh(hoodGeometry, mantle, [0, 0, 0])
  const hoodEdge: number[][] = []
  for (let i = 0; i <= 64; i++) hoodEdge.push(hoodVertices.slice(i * 3, i * 3 + 3))
  tube(hoodEdge, 0.014, robe)
  const face = mesh(new THREE.SphereGeometry(0.225, 32, 24), lining, [0, 2.06, 0.01]); face.scale.set(1, 1.33, 0.55)
  for (const side of [-1, 1]) {
    const eye = mesh(new THREE.SphereGeometry(0.021, 16, 10), glow, [side * 0.085, 2.13, 0.15])
    eye.scale.set(1.35, 0.32, 0.6); eye.rotation.z = side * 0.18
    tube([[side * 0.24, 1.96, 0.15], [side * 0.14, 1.86, 0.18], [side * 0.06, 1.8, 0.14]], 0.025, robe)
  }
  // Folded face veil and cowl recess the eyes beneath the hood instead of a flat black oval.
  const veil = mesh(cloth(0.22, 0.18, 0.28, -Math.PI * 0.5, Math.PI), robe, [0, 1.78, 0.08])
  veil.scale.z = 0.62
  for (let i = 0; i < 3; i++) {
    tube([[-0.2, 1.9 - i * 0.045, 0.17], [0, 1.84 - i * 0.04, 0.22], [0.2, 1.9 - i * 0.045, 0.17]], 0.018, mantle)
  }
  const pagePivot = new THREE.Group(), performance = new THREE.Group()
  const prop = new THREE.Group(); prop.position.set(0, 1.18, 0.75); body.add(prop)
  if (variant === 'analyst') {
    for (const side of [-1, 1]) {
      const half = new THREE.Group(); half.rotation.z = side * 0.18; half.position.x = side * 0.22; prop.add(half)
      mesh(new THREE.BoxGeometry(0.45, 0.055, 0.43), metal, [0, 0, 0], half)
      mesh(new THREE.BoxGeometry(0.41, 0.045, 0.39), standard('#c5b8a0'), [0, 0.048, 0], half)
      for (let line = 0; line < 7; line++) tube([[-0.15, 0.074, -0.14 + line * 0.045], [0.13, 0.074, -0.14 + line * 0.045]], 0.003, glow, half)
    }
    prop.add(pagePivot)
    pagePivot.position.y = 0.09
    mesh(new THREE.PlaneGeometry(0.4, 0.37, 8, 1), standard('#d3c6a9'), [0.2, 0, 0], pagePivot).rotation.x = -Math.PI / 2
  } else if (variant === 'fixer') {
    prop.rotation.z = -0.55
    mesh(new THREE.BoxGeometry(0.095, 1.05, 0.075), metal, [0.12, 0.18, 0], prop)
    const jaw = new THREE.Shape()
    jaw.moveTo(-0.19, 0); jaw.lineTo(-0.24, 0.19); jaw.lineTo(-0.14, 0.31); jaw.lineTo(-0.12, 0.13)
    jaw.lineTo(0.09, 0.1); jaw.lineTo(0.18, 0.26); jaw.lineTo(0.23, 0.09); jaw.lineTo(0.14, -0.06); jaw.closePath()
    mesh(new THREE.ExtrudeGeometry(jaw, { depth: 0.065, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.018, bevelThickness: 0.012 }), metal, [0.12, 0.68, -0.03], prop)
    tube([[0.12, -0.3, 0.045], [0.12, 0.63, 0.045]], 0.009, glow, prop)
  }
  if (variant === 'fixer') {
    performance.position.set(0, 1.5, 0.95); body.add(performance)
    mesh(new THREE.TorusGeometry(0.27, 0.012, 8, 48), glow, [0, 0, 0], performance)
    const rune = mesh(new THREE.OctahedronGeometry(0.13), glow, [0, 0, 0], performance); rune.scale.z = 0.2
  }
  // Floating glass displays are actual world-space objects, with role-specific diagrams.
  const display = new THREE.Group(); display.position.set(variant === 'tester' ? 0 : 0.85, variant === 'tester' ? 1.42 : 1.72, 0.58)
  display.rotation.set(-0.12, -0.12, variant === 'tester' ? -0.1 : 0.08); body.add(display)
  const glass = standard(accent.clone().multiplyScalar(0.12), 0.2); glass.depthWrite = false
  mesh(new THREE.PlaneGeometry(0.74, 0.58), glass, [0, 0, 0], display)
  tube([[-0.37, -0.29, 0], [-0.37, 0.29, 0], [0.37, 0.29, 0], [0.37, -0.29, 0], [-0.37, -0.29, 0]], 0.006, glow, display)
  for (let i = 0; i < 3; i++) {
    const y = 0.16 - i * 0.16
    if (variant === 'tester') tube([[-0.28, y, 0.01], [-0.23, y - 0.045, 0.01], [-0.15, y + 0.05, 0.01]], 0.009, glow, display)
    tube([[variant === 'tester' ? -0.08 : -0.28, y, 0.01], [0.12 + i * 0.055, y, 0.01]], 0.004, glow, display)
  }
  if (variant === 'analyst') tube([[-0.28, -0.2, 0.02], [-0.1, 0.02, 0.02], [0.05, -0.1, 0.02], [0.28, 0.21, 0.02]], 0.009, glow, display)
  if (variant === 'tester') {
    const seal = performance; seal.position.set(0.83, 1.94, 0.22); body.add(seal)
    mesh(new THREE.TorusGeometry(0.23, 0.008, 6, 64), glow, [0, 0, 0], seal)
    tube([[-0.12, 0, 0], [-0.025, -0.085, 0], [0.14, 0.12, 0]], 0.018, glow, seal)
  }

  const light = new THREE.PointLight('#c0cce5', 0, options.lightDistance ?? 9, 2); light.position.set(-0.5, 2.5, 1.3); body.add(light)
  const rim = new THREE.PointLight(accent, 0, 5, 2); rim.position.set(0, 1.8, -0.8); body.add(rim)
  const particlesGeometry = new THREE.BufferGeometry(), positions = new Float32Array(180 * 3)
  for (let i = 0; i < 180; i++) { const a = i * 2.4, radius = 0.5 + (i % 17) / 20; positions.set([Math.cos(a) * radius, (i % 31) / 12, Math.sin(a) * radius * 0.7], i * 3) }
  particlesGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const particleMaterial = new THREE.PointsMaterial({ color: accent, size: 0.035, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })
  materials.push(particleMaterial)
  const particles = new THREE.Points(particlesGeometry, particleMaterial); body.add(particles)
  // Soft ground wisps use a radial alpha texture instead of opaque particle squares.
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64
  const context = canvas.getContext('2d')!
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32)
  gradient.addColorStop(0, 'rgba(255,255,255,0.45)'); gradient.addColorStop(0.4, 'rgba(255,255,255,0.15)'); gradient.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = gradient; context.fillRect(0, 0, 64, 64)
  const smokeTexture = new THREE.CanvasTexture(canvas); textures.push(smokeTexture)
  particleMaterial.map = smokeTexture
  const smokeMaterial = new THREE.SpriteMaterial({ map: smokeTexture, color: accent, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 })
  materials.push(smokeMaterial)
  const wisps = Array.from({ length: 5 }, (_, i) => { const sprite = new THREE.Sprite(smokeMaterial); sprite.scale.set(1.6, 0.75, 1); sprite.position.set(Math.sin(i * 2.4) * 0.7, 0.15 + i * 0.08, Math.cos(i * 2.4) * 0.5); body.add(sprite); return sprite })
  batchStaticMeshes(display)
  batchStaticMeshes(prop, new Set<THREE.Object3D>([pagePivot]))
  batchStaticMeshes(performance)
  batchStaticMeshes(body, new Set<THREE.Object3D>([display, prop, performance, ...tatters]))
  let timeline = 0, elapsed = 0
  let previousTime: number | undefined, motionTime = 0
  const set = (T: number, time: number, _pose = 1, fade = 1, local = -1) => {
    timeline = T; elapsed = time
    motionTime += Math.min(0.05, Math.max(0, time - (previousTime ?? time)))
    previousTime = time
    time = motionTime
    clothTime.value = time
    const gesture = smooth((local - 0.07) / 0.045) * (1 - smooth((local - 0.19) / 0.045))
    if (variant === 'analyst') {
      pagePivot.rotation.z = smooth((local - 0.08) / 0.09) * Math.PI
      prop.position.y = 1.18 + gesture * 0.08
      prop.rotation.x = -gesture * 0.1
    } else if (variant === 'fixer') {
      prop.rotation.z = -0.55 + Math.sin(gesture * Math.PI * 0.75) * 0.28
      performance.scale.setScalar(Math.max(0.001, gesture))
      performance.rotation.z = time * 0.45
    } else {
      performance.scale.setScalar(0.7 + gesture * 0.3)
      performance.rotation.y = (1 - smooth((local - 0.06) / 0.1)) * Math.PI / 2
      display.rotation.z = -0.1 + gesture * 0.1
    }
    const appear = smooth((T - 4.8) / 4.5) * THREE.MathUtils.clamp(fade, 0, 1)
    materials.forEach(material => { material.opacity = appear * (material === glass ? 0.65 : material === smokeMaterial ? 0.25 : material === particleMaterial ? 0.65 : 1) })
    light.intensity = appear * (options.lightIntensity ?? 1.15) * 3; rim.intensity = appear * 0.75
    body.position.y = Math.sin(time * 0.8) * 0.035 - (1 - appear) * 0.25
    body.rotation.z = Math.sin(time * 0.6) * 0.009
    tatters.forEach((tatter, i) => { tatter.rotation.x = Math.sin(time * 1.1 + i * 0.7) * 0.12 })
    display.position.y = (variant === 'tester' ? 1.42 : 1.72) + Math.sin(time * 0.9) * 0.035
    particles.rotation.y = time * 0.08
    wisps.forEach((sprite, i) => { sprite.position.x = Math.sin(time * 0.28 + i * 2.4) * 0.85; sprite.position.y = 0.1 + ((time * 0.09 + i * 0.14) % 0.9) })
    root.visible = appear > 0.003
    return appear
  }
  return {
    group: root, set,
    update(dt: number) { return set(timeline + dt, elapsed + dt) },
    setPixelRatio(_ratio: number) {},
    dispose() {
      const geometries = new Set<THREE.BufferGeometry>()
      root.traverse(node => { const geometry = (node as THREE.Mesh).geometry; if (geometry) geometries.add(geometry) })
      geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose()); textures.forEach(texture => texture.dispose())
      parent.remove(root)
    },
  }
}
