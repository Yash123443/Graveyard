import * as THREE from 'three'

/* ------------------------------------------------------------------ */
/*  Tiny deterministic noise toolkit (no external assets required)     */
/* ------------------------------------------------------------------ */

function hash(x: number, y: number, seed: number) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

function valueNoise(x: number, y: number, seed: number, px = 0, py = 0) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const wx = (n: number) => (px > 0 ? ((n % px) + px) % px : n)
  const wy = (n: number) => (py > 0 ? ((n % py) + py) % py : n)
  const a = hash(wx(xi), wy(yi), seed)
  const b = hash(wx(xi + 1), wy(yi), seed)
  const c = hash(wx(xi), wy(yi + 1), seed)
  const d = hash(wx(xi + 1), wy(yi + 1), seed)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

/**
 * fbm over normalised coordinates (nx, ny in 0..1). `cellsX/cellsY` is the
 * base lattice size; when `tile` is true the lattice wraps so the texture
 * repeats seamlessly. Non-tiling callers (sprites) pass tile=false.
 */
function fbm(nx: number, ny: number, seed: number, octaves = 5, cellsX = 4, cellsY = cellsX, tile = true) {
  let amp = 0.5
  let freq = 1
  let sum = 0
  let norm = 0
  for (let o = 0; o < octaves; o += 1) {
    const cx = Math.max(1, Math.round(cellsX * freq))
    const cy = Math.max(1, Math.round(cellsY * freq))
    sum += amp * valueNoise(nx * cx, ny * cy, seed + o, tile ? cx : 0, tile ? cy : 0)
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return sum / norm
}

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  return { canvas, ctx }
}

function toTexture(canvas: HTMLCanvasElement, srgb = true) {
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  texture.anisotropy = 8
  texture.needsUpdate = true
  return texture
}

/* ------------------------------------------------------------------ */
/*  Rusty iron: colour + bump from the same height field               */
/* ------------------------------------------------------------------ */

export function createRustTextures(size = 512) {
  const color = makeCanvas(size, size)
  const bump = makeCanvas(size, size)
  const colorData = color.ctx.createImageData(size, size)
  const bumpData = bump.ctx.createImageData(size, size)
  const period = 4

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x / size
      const ny = y / size
      const body = fbm(nx, ny, 11, 5, period * 1, period * 1)
      const blotch = fbm(nx, ny, 29, 4, period * 1.7, period * 1.7)
      // vertical rain streaks stretched along y
      const streak = fbm(nx, ny, 53, 3, period * 6, period * 0.45)
      const pitting = hash(x, y, 7)

      const rust = smooth(0.46, 0.7, blotch * 0.7 + streak * 0.45)
      const flake = smooth(0.78, 0.95, body + (pitting - 0.5) * 0.35)

      // base: near-black cold iron
      let r = 28 + body * 26
      let g = 27 + body * 24
      let b = 30 + body * 24
      // oxidised orange / brown
      const rr = 118 - flake * 40 + body * 30
      const rg = 56 + body * 22 - flake * 16
      const rb = 28 + body * 10
      r += (rr - r) * rust
      g += (rg - g) * rust
      b += (rb - b) * rust
      // dark pitting
      const pit = pitting < 0.035 ? 0.45 : 1
      r *= pit
      g *= pit
      b *= pit

      const i = (y * size + x) * 4
      colorData.data[i] = r
      colorData.data[i + 1] = g
      colorData.data[i + 2] = b
      colorData.data[i + 3] = 255

      const height = 120 + body * 90 + rust * 40 - flake * 55 - (pitting < 0.035 ? 70 : 0) + (pitting - 0.5) * 22
      const hv = Math.max(0, Math.min(255, height))
      bumpData.data[i] = hv
      bumpData.data[i + 1] = hv
      bumpData.data[i + 2] = hv
      bumpData.data[i + 3] = 255
    }
  }

  color.ctx.putImageData(colorData, 0, 0)
  bump.ctx.putImageData(bumpData, 0, 0)

  const map = toTexture(color.canvas)
  const bumpMap = toTexture(bump.canvas, false)
  for (const t of [map, bumpMap]) {
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
  }
  return { map, bumpMap }
}

/* ------------------------------------------------------------------ */
/*  Weathered stone with cracks and moss                               */
/* ------------------------------------------------------------------ */

export function createStoneTextures(size = 512) {
  const color = makeCanvas(size, size)
  const bump = makeCanvas(size, size)
  const colorData = color.ctx.createImageData(size, size)
  const bumpData = bump.ctx.createImageData(size, size)
  const period = 4

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x / size
      const ny = y / size
      const grain = fbm(nx, ny, 91, 5, period * 2, period * 2)
      const blocks = fbm(nx, ny, 17, 3, period * 0.8, period * 0.8)
      const moss = smooth(0.52, 0.72, fbm(nx, ny, 61, 4, period * 1.3, period * 1.3)) * smooth(0.25, 0.85, y / size)
      const speck = hash(x, y, 3)

      // Aged limestone still catches the weak cemetery fill; keep the face
      // textured, but lift it out of silhouette so carvings read at night.
      let r = 82 + grain * 42 + blocks * 12
      let g = 84 + grain * 42 + blocks * 12
      let b = 83 + grain * 38 + blocks * 12
      r += (36 - r) * moss * 0.8
      g += (62 - g) * moss * 0.8
      b += (38 - b) * moss * 0.8
      const dirt = (speck - 0.5) * 14
      const i = (y * size + x) * 4
      colorData.data[i] = r + dirt
      colorData.data[i + 1] = g + dirt
      colorData.data[i + 2] = b + dirt
      colorData.data[i + 3] = 255
      const hv = 110 + grain * 110 + (speck - 0.5) * 30
      bumpData.data[i] = hv
      bumpData.data[i + 1] = hv
      bumpData.data[i + 2] = hv
      bumpData.data[i + 3] = 255
    }
  }
  color.ctx.putImageData(colorData, 0, 0)
  bump.ctx.putImageData(bumpData, 0, 0)

  // hairline cracks drawn onto both maps
  for (const { ctx, dark } of [
    { ctx: color.ctx, dark: 'rgba(8,10,12,0.75)' },
    { ctx: bump.ctx, dark: 'rgba(0,0,0,0.95)' },
  ]) {
    ctx.lineCap = 'round'
    for (let c = 0; c < 9; c += 1) {
      let px = hash(c, 1, 5) * size
      let py = hash(c, 2, 5) * size
      ctx.strokeStyle = dark
      ctx.lineWidth = 1.2 + hash(c, 3, 5) * 1.4
      ctx.beginPath()
      ctx.moveTo(px, py)
      for (let s = 0; s < 14; s += 1) {
        px += (hash(c, s + 10, 9) - 0.5) * 46
        py += hash(c, s + 40, 9) * 34
        ctx.lineTo(px, py)
      }
      ctx.stroke()
    }
  }

  const map = toTexture(color.canvas)
  const bumpMap = toTexture(bump.canvas, false)
  for (const t of [map, bumpMap]) {
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
  }
  return { map, bumpMap }
}

/* ------------------------------------------------------------------ */
/*  Muddy cemetery ground                                              */
/* ------------------------------------------------------------------ */

export function createGroundTexture(size = 512) {
  const { canvas, ctx } = makeCanvas(size, size)
  const bump = makeCanvas(size, size)
  const data = ctx.createImageData(size, size)
  const bumpData = bump.ctx.createImageData(size, size)
  const period = 4
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x / size
      const ny = y / size
      const n = fbm(nx, ny, 5, 5, period * 2, period * 2)
      const patch = fbm(nx, ny, 77, 3, period * 0.7, period * 0.7)
      const wet = smooth(0.55, 0.7, patch)
      const speck = hash(x, y, 9)
      // Dark umber loam with damp, near-black patches; keep the ground visibly earthy
      // beneath the cold moonlight instead of letting it drift toward blue-grey.
      const r = 38 + n * 34 - wet * 9 + (speck - 0.5) * 14
      const g = 23 + n * 24 - wet * 6 + (speck - 0.5) * 10
      const b = 12 + n * 15 + wet * 2 + (speck - 0.5) * 8
      const i = (y * size + x) * 4
      data.data[i] = r
      data.data[i + 1] = g
      data.data[i + 2] = b
      data.data[i + 3] = 255
      const height = 84 + n * 112 + wet * 26 + (speck - 0.5) * 34
      bumpData.data[i] = height
      bumpData.data[i + 1] = height
      bumpData.data[i + 2] = height
      bumpData.data[i + 3] = 255
    }
  }
  ctx.putImageData(data, 0, 0)
  bump.ctx.putImageData(bumpData, 0, 0)
  const map = toTexture(canvas)
  const bumpMap = toTexture(bump.canvas, false)
  for (const texture of [map, bumpMap]) {
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(26, 26)
  }
  return { map, bumpMap }
}

/* ------------------------------------------------------------------ */
/*  Moon: maria + impact craters                                       */
/* ------------------------------------------------------------------ */

export function createMoonTexture(width = 2048, height = 1024) {
  const { canvas, ctx } = makeCanvas(width, height)
  const data = ctx.createImageData(width, height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = x / width
      const ny = y / height
      const base = fbm(nx, ny, 3, 6, 16, 8, false)
      const maria = smooth(0.48, 0.64, fbm(nx, ny, 21, 5, 11, 7, false))
      const fine = fbm(nx, ny, 8, 4, 145, 74, false)
      let lum = 0.9 + (base - 0.5) * 0.42 + (fine - 0.5) * 0.2
      lum -= maria * 0.18
      const i = (y * width + x) * 4
      data.data[i] = lum * 232
      data.data[i + 1] = lum * 240
      data.data[i + 2] = lum * 252
      data.data[i + 3] = 255
    }
  }
  ctx.putImageData(data, 0, 0)

  for (let c = 0; c < 780; c += 1) {
    const cx = hash(c, 1, 41) * width
    const cy = (0.12 + hash(c, 2, 41) * 0.76) * height
    const size = Math.pow(hash(c, 3, 41), 2.8) * 32 + 1.5
    const squash = 1 // equirect: keep circular, poles are hidden anyway
    // Subtle bowl shadow, a narrow broken ejecta rim, and a soft outer falloff.
    // The previous broad white rim made every impact read as a drawn circle.
    const grad = ctx.createRadialGradient(cx, cy, size * 0.04, cx, cy, size)
    grad.addColorStop(0, 'rgba(35,45,58,0.2)')
    grad.addColorStop(0.48, 'rgba(55,67,82,0.12)')
    grad.addColorStop(0.72, 'rgba(69,81,96,0.05)')
    grad.addColorStop(0.82, 'rgba(230,238,246,0.06)')
    grad.addColorStop(0.9, 'rgba(48,60,75,0.06)')
    grad.addColorStop(1, 'rgba(50,62,80,0)')
    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(1, squash)
    ctx.translate(-cx, -cy)
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(cx, cy, size, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  const texture = toTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  return texture
}

/* ------------------------------------------------------------------ */
/*  Soft alpha sprites for clouds, fog and moon halo                   */
/* ------------------------------------------------------------------ */

export function createCloudTexture(seed: number, width = 512, height = 256) {
  const { canvas, ctx } = makeCanvas(width, height)
  const data = ctx.createImageData(width, height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = x / width
      const ny = y / height
      const dx = (nx - 0.5) * 2
      const dy = (ny - 0.5) * 2
      const falloff = Math.max(0, 1 - Math.pow(dx * dx * 0.9 + dy * dy * 1.7, 0.85))
      const n = fbm(nx, ny, seed, 6, 5, 3, false)
      const density = smooth(0.34, 0.74, n * 1.05) * falloff
      // lit upper edge = brighter, belly darker
      const light = 0.55 + (1 - ny) * 0.45
      const i = (y * width + x) * 4
      const v = 120 + light * 135
      data.data[i] = v
      data.data[i + 1] = v
      data.data[i + 2] = v + 6
      data.data[i + 3] = density * 255
    }
  }
  ctx.putImageData(data, 0, 0)
  return toTexture(canvas)
}

export function createFogTexture(seed: number, size = 256) {
  const { canvas, ctx } = makeCanvas(size, size)
  const data = ctx.createImageData(size, size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x / size
      const ny = y / size
      const dx = (nx - 0.5) * 2
      const dy = (ny - 0.5) * 2
      const radial = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy))
      const n = fbm(nx, ny, seed, 5, 4, 4, false)
      const a = Math.pow(radial, 1.3) * smooth(0.25, 0.8, n)
      const i = (y * size + x) * 4
      data.data[i] = 255
      data.data[i + 1] = 255
      data.data[i + 2] = 255
      data.data[i + 3] = a * 255
    }
  }
  ctx.putImageData(data, 0, 0)
  return toTexture(canvas)
}

export function createGlowTexture(size = 512) {
  const { canvas, ctx } = makeCanvas(size, size)
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.18, 'rgba(210,232,255,0.55)')
  grad.addColorStop(0.45, 'rgba(150,190,230,0.16)')
  grad.addColorStop(1, 'rgba(120,160,210,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  return toTexture(canvas)
}
