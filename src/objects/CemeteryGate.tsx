import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq, smoothstep } from '../animations/sequence'
import { createRustTextures, createStoneTextures } from '../utils/proceduralTextures'

export const GATE_Z = -8
const HINGE_X = 5.4
const LEAF_W = 5.25
const LEAF_BOTTOM = 0.32
const LEAF_TOP = 6.55

const rand = (i: number, k = 0) => {
  const s = Math.sin(i * 91.7 + k * 17.3) * 43758.5453
  return s - Math.floor(s)
}

/* ------------------------------------------------------------------ */
/*  Shared materials: rust + stone, tinted by the scene-1 reveal       */
/* ------------------------------------------------------------------ */

function useGateMaterials() {
  const mats = useMemo(() => {
    const rust = createRustTextures(512)
    const stone = createStoneTextures(512)

    const variant = (src: THREE.Texture, rx: number, ry: number) => {
      const t = src.clone()
      t.repeat.set(rx, ry)
      t.needsUpdate = true
      return t
    }

    const rail = new THREE.MeshStandardMaterial({
      map: variant(rust.map, 3, 1),
      bumpMap: variant(rust.bumpMap, 3, 1),
      bumpScale: 2.4,
      roughness: 0.82,
      metalness: 0.32,
    })
    const bar = new THREE.MeshStandardMaterial({
      map: variant(rust.map, 1, 5),
      bumpMap: variant(rust.bumpMap, 1, 5),
      bumpScale: 2.0,
      roughness: 0.8,
      metalness: 0.3,
    })
    const heavy = new THREE.MeshStandardMaterial({
      map: variant(rust.map, 1.5, 1.5),
      bumpMap: variant(rust.bumpMap, 1.5, 1.5),
      bumpScale: 3,
      roughness: 0.9,
      metalness: 0.2,
      color: new THREE.Color('#d8b9a3'), // a touch warmer — heavily oxidised hardware
    })
    const pillar = new THREE.MeshStandardMaterial({
      map: variant(stone.map, 1, 3),
      bumpMap: variant(stone.bumpMap, 1, 3),
      bumpScale: 3,
      roughness: 0.96,
      metalness: 0,
    })
    const stoneBlock = new THREE.MeshStandardMaterial({
      map: variant(stone.map, 1, 1),
      bumpMap: variant(stone.bumpMap, 1, 1),
      bumpScale: 3,
      roughness: 0.96,
      metalness: 0,
    })
    return { rail, bar, heavy, pillar, stoneBlock }
  }, [])

  useFrame(() => {
    const k = seq.reveal.gate
    mats.rail.color.setScalar(k)
    mats.bar.color.setScalar(k)
    mats.heavy.color.setRGB(0.85 * k, 0.72 * k, 0.64 * k)
    mats.pillar.color.setScalar(k)
    mats.stoneBlock.color.setScalar(k)
  })
  return mats
}

type Mats = ReturnType<typeof useGateMaterials>

/* ------------------------------------------------------------------ */
/*  Instanced railings: bars, finials, collars                         */
/* ------------------------------------------------------------------ */

interface BarSpec {
  x: number
  y0: number
  y1: number
  tilt: number
  finial: boolean
}

function InstancedBars({ bars, mats, radius = 0.045, spear = true }: { bars: BarSpec[]; mats: Mats; radius?: number; spear?: boolean }) {
  const shafts = useRef<THREE.InstancedMesh>(null)
  const tips = useRef<THREE.InstancedMesh>(null)
  const collars = useRef<THREE.InstancedMesh>(null)

  useLayoutEffect(() => {
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const s = new THREE.Vector3()
    const p = new THREE.Vector3()
    let t = 0
    bars.forEach((b, i) => {
      const h = b.y1 - b.y0
      e.set(0, 0, b.tilt)
      q.setFromEuler(e)
      p.set(b.x, b.y0 + h / 2, 0)
      s.set(1, h, 1)
      m.compose(p, q, s)
      shafts.current?.setMatrixAt(i, m)

      if (b.finial && spear) {
        const tipOffset = Math.sin(b.tilt) * -h * 0.5
        // spear head
        p.set(b.x + tipOffset + Math.sin(-b.tilt) * 0.18, b.y1 + 0.2, 0)
        q.setFromEuler(e)
        s.set(1, 1, 1)
        m.compose(p, q, s)
        tips.current?.setMatrixAt(t, m)
        // collar ball
        p.set(b.x + tipOffset, b.y1 - 0.02, 0)
        m.compose(p, q, s)
        collars.current?.setMatrixAt(t, m)
        t += 1
      }
    })
    ;[shafts, tips, collars].forEach((ref) => {
      if (ref.current) ref.current.instanceMatrix.needsUpdate = true
    })
    if (tips.current) tips.current.count = t
    if (collars.current) collars.current.count = t
  }, [bars, spear])

  const finialCount = bars.filter((b) => b.finial).length

  return (
    <group>
      <instancedMesh ref={shafts} args={[undefined, undefined, bars.length]} castShadow receiveShadow material={mats.bar}>
        <cylinderGeometry args={[radius, radius * 1.05, 1, 8]} />
      </instancedMesh>
      {spear && (
        <>
          <instancedMesh ref={tips} args={[undefined, undefined, finialCount]} castShadow material={mats.heavy}>
            <coneGeometry args={[radius * 2.6, 0.5, 4]} />
          </instancedMesh>
          <instancedMesh ref={collars} args={[undefined, undefined, finialCount]} castShadow material={mats.heavy}>
            <sphereGeometry args={[radius * 2.2, 8, 6]} />
          </instancedMesh>
        </>
      )}
    </group>
  )
}

/* ------------------------------------------------------------------ */
/*  One gate leaf (built extending +x from its hinge)                  */
/* ------------------------------------------------------------------ */

function GateLeaf({ side, mats }: { side: 'left' | 'right'; mats: Mats }) {
  const hinge = useRef<THREE.Group>(null)
  const chain = useRef<THREE.Group>(null)
  const dir = side === 'left' ? 1 : -1
  const seed = side === 'left' ? 1 : 7

  const bars = useMemo<BarSpec[]>(() => {
    const n = 14
    const list: BarSpec[] = []
    for (let i = 0; i < n; i += 1) {
      // one bar torn out of the right leaf, a couple bent
      if (side === 'right' && i === 9) continue
      const x = 0.42 + (i * (LEAF_W - 0.62)) / (n - 1)
      const tall = i % 2 === 0
      const top = LEAF_TOP + (tall ? 0.38 : 0.02)
      const bent = (side === 'left' && i === 4) || (side === 'right' && i === 5)
      list.push({
        x,
        y0: LEAF_BOTTOM,
        y1: top - (bent ? 0.5 : 0),
        tilt: bent ? 0.09 : (rand(i, seed) - 0.5) * 0.014,
        finial: !bent,
      })
    }
    return list
  }, [side, seed])

  // each leaf opens at its own pace and shudders against its rusted hinges (stick-slip)
  useFrame(({ clock }) => {
    if (!hinge.current) return
    const o = seq.gateOpen
    const own = side === 'left' ? o : smoothstep(0.04, 1, o) * 0.97 + (o > 0.995 ? 0.03 : 0)
    const max = side === 'left' ? 1.5 : 1.38
    const shudder = Math.sin(own * 64 + (side === 'left' ? 0 : 2)) * 0.012 * Math.sin(own * Math.PI)
    hinge.current.rotation.y = dir * (own * max + shudder)
    if (chain.current) {
      chain.current.rotation.z = Math.sin(clock.elapsedTime * 0.8) * 0.03 + own * 0.25
    }
  })

  const braceAngle = Math.atan2(LEAF_TOP - 1.0 - 0.3, LEAF_W)

  return (
    <group ref={hinge} position={[-dir * HINGE_X, 0, GATE_Z]}>
      <group scale={[dir, 1, 1]}>
        {/* frame: stiles + rails */}
        <mesh position={[0.1, (LEAF_BOTTOM + LEAF_TOP) / 2 + 0.05, 0]} material={mats.heavy} castShadow>
          <boxGeometry args={[0.2, LEAF_TOP - LEAF_BOTTOM + 0.15, 0.2]} />
        </mesh>
        <mesh position={[LEAF_W, (LEAF_BOTTOM + LEAF_TOP) / 2, 0]} material={mats.heavy} castShadow>
          <boxGeometry args={[0.16, LEAF_TOP - LEAF_BOTTOM + 0.1, 0.16]} />
        </mesh>
        {[LEAF_BOTTOM + 0.1, 1.15, 3.4, LEAF_TOP - 0.35].map((y, i) => (
          <mesh key={i} position={[LEAF_W / 2, y, i % 2 ? 0.02 : -0.01]} material={mats.rail} castShadow receiveShadow>
            <boxGeometry args={[LEAF_W, i === 2 ? 0.15 : 0.19, i === 2 ? 0.13 : 0.17]} />
          </mesh>
        ))}

        <InstancedBars bars={bars} mats={mats} />

        {/* big ring ornaments between the mid and top rails */}
        {[0.27, 0.73].map((f, i) => (
          <group key={i} position={[LEAF_W * f, 4.85, 0.07]}>
            <mesh material={mats.rail} castShadow>
              <torusGeometry args={[0.78, 0.05, 8, 40]} />
            </mesh>
            <mesh material={mats.rail} castShadow>
              <torusGeometry args={[0.36, 0.04, 8, 32]} />
            </mesh>
            <mesh material={mats.heavy} castShadow position={[0, 0, 0.01]}>
              <sphereGeometry args={[0.1, 10, 8]} />
            </mesh>
          </group>
        ))}
        {/* scroll arcs linking the rings */}
        <mesh position={[LEAF_W * 0.5, 4.85, 0.08]} rotation={[0, 0, Math.PI]} material={mats.rail} castShadow>
          <torusGeometry args={[0.55, 0.04, 8, 28, Math.PI]} />
        </mesh>
        <mesh position={[LEAF_W * 0.5, 4.85, 0.08]} material={mats.rail} castShadow>
          <torusGeometry args={[0.55, 0.04, 8, 28, Math.PI]} />
        </mesh>

        {/* lower diagonal brace */}
        <mesh position={[LEAF_W / 2, (1.15 + 3.4) / 2, 0.09]} rotation={[0, 0, braceAngle * 0.72]} material={mats.rail} castShadow>
          <boxGeometry args={[Math.hypot(LEAF_W, 2.25), 0.09, 0.08]} />
        </mesh>
        <mesh position={[LEAF_W / 2, (1.15 + 3.4) / 2, 0.095]} rotation={[0, 0, -braceAngle * 0.72]} material={mats.rail} castShadow>
          <boxGeometry args={[Math.hypot(LEAF_W, 2.25), 0.07, 0.07]} />
        </mesh>

        {/* hinges: heavy knuckles + straps */}
        {[1.0, 5.8].map((y, i) => (
          <group key={i} position={[0.02, y, 0]}>
            <mesh material={mats.heavy} castShadow>
              <cylinderGeometry args={[0.16, 0.16, 0.5, 12]} />
            </mesh>
            <mesh position={[0.9, 0, 0.1]} material={mats.heavy} castShadow>
              <boxGeometry args={[1.8, 0.14, 0.05]} />
            </mesh>
          </group>
        ))}

        {/* spear-tipped corner posts */}
        <mesh position={[LEAF_W, LEAF_TOP + 0.35, 0]} material={mats.heavy} castShadow rotation={[0, Math.PI / 4, 0]}>
          <coneGeometry args={[0.16, 0.7, 4]} />
        </mesh>
        <mesh position={[0.1, LEAF_TOP + 0.45, 0]} material={mats.heavy} castShadow rotation={[0, Math.PI / 4, 0]}>
          <coneGeometry args={[0.18, 0.85, 4]} />
        </mesh>

        {/* latch + chain + padlock hanging from the left leaf only */}
        {side === 'left' ? (
          <group position={[LEAF_W + 0.05, 3.4, 0.14]}>
            <mesh material={mats.heavy} castShadow>
              <boxGeometry args={[0.3, 0.24, 0.08]} />
            </mesh>
            <group ref={chain} position={[0.02, -0.14, 0.06]}>
              {Array.from({ length: 9 }, (_, i) => (
                <mesh key={i} position={[0, -0.13 - i * 0.14, 0]} rotation={[i % 2 ? 0 : Math.PI / 2, 0, 0]} material={mats.heavy} castShadow>
                  <torusGeometry args={[0.07, 0.022, 6, 12]} />
                </mesh>
              ))}
              <group position={[0, -1.55, 0]}>
                <mesh material={mats.heavy} castShadow>
                  <boxGeometry args={[0.28, 0.32, 0.14]} />
                </mesh>
                <mesh position={[0, 0.24, 0]} material={mats.heavy} castShadow>
                  <torusGeometry args={[0.1, 0.03, 6, 14, Math.PI]} />
                </mesh>
              </group>
            </group>
          </group>
        ) : (
          <mesh position={[LEAF_W - 0.05, 3.4, 0.12]} material={mats.heavy} castShadow>
            <boxGeometry args={[0.34, 0.5, 0.1]} />
          </mesh>
        )}
      </group>
    </group>
  )
}

/* ------------------------------------------------------------------ */
/*  Stone pillar                                                       */
/* ------------------------------------------------------------------ */

function Pillar({ x, mats, lean }: { x: number; mats: Mats; lean: number }) {
  return (
    <group position={[x, 0, GATE_Z]} rotation={[0, 0, lean]}>
      <mesh position={[0, 0.5, 0]} material={mats.stoneBlock} castShadow receiveShadow>
        <boxGeometry args={[1.95, 1.0, 1.95]} />
      </mesh>
      <mesh position={[0, 5.05, 0]} material={mats.pillar} castShadow receiveShadow>
        <boxGeometry args={[1.5, 8.2, 1.5]} />
      </mesh>
      {[2.2, 4.4, 6.6].map((y) => (
        <mesh key={y} position={[0, y, 0]} material={mats.stoneBlock} castShadow>
          <boxGeometry args={[1.58, 0.1, 1.58]} />
        </mesh>
      ))}
      <mesh position={[0, 9.3, 0]} material={mats.stoneBlock} castShadow receiveShadow>
        <boxGeometry args={[1.95, 0.4, 1.95]} />
      </mesh>
      <mesh position={[0, 9.9, 0]} rotation={[0, Math.PI / 4, 0]} material={mats.stoneBlock} castShadow>
        <coneGeometry args={[1.25, 0.9, 4]} />
      </mesh>
      <mesh position={[0, 10.55, 0]} material={mats.stoneBlock} castShadow>
        <sphereGeometry args={[0.3, 16, 12]} />
      </mesh>
    </group>
  )
}

/* ------------------------------------------------------------------ */
/*  Iron overthrow arch                                                */
/* ------------------------------------------------------------------ */

function Overthrow({ mats }: { mats: Mats }) {
  const BEAM_Y = 8.7
  const RISE = 2.1
  const R = HINGE_X
  const spokes = useMemo<BarSpec[]>(() => {
    const list: BarSpec[] = []
    const n = 21
    for (let i = 1; i < n; i += 1) {
      const th = (i / n) * Math.PI
      const top = Math.sin(th) * RISE
      list.push({ x: Math.cos(th) * R, y0: BEAM_Y, y1: BEAM_Y + top, tilt: 0, finial: false })
    }
    return list
  }, [R])

  return (
    <group position={[0, 0, GATE_Z]}>
      <mesh position={[0, BEAM_Y, 0]} material={mats.rail} castShadow>
        <boxGeometry args={[R * 2 + 1, 0.28, 0.22]} />
      </mesh>
      <mesh position={[0, BEAM_Y, 0]} rotation={[0, 0, 0]} scale={[1, RISE / R, 1]} material={mats.rail} castShadow>
        <torusGeometry args={[R, 0.12, 10, 56, Math.PI]} />
      </mesh>
      <mesh position={[0, BEAM_Y, 0]} scale={[0.93, (RISE * 0.8) / (R * 0.93), 1]} material={mats.rail} castShadow>
        <torusGeometry args={[R * 0.93, 0.06, 8, 56, Math.PI]} />
      </mesh>
      <InstancedBars bars={spokes} mats={mats} radius={0.035} spear={false} />
      {/* central iron cross */}
      <group position={[0, BEAM_Y + RISE + 0.1, 0]}>
        <mesh position={[0, 0.5, 0]} material={mats.heavy} castShadow>
          <boxGeometry args={[0.16, 1.2, 0.14]} />
        </mesh>
        <mesh position={[0, 0.72, 0]} material={mats.heavy} castShadow>
          <boxGeometry args={[0.7, 0.14, 0.14]} />
        </mesh>
      </group>
      {/* hanging ring ornaments under the beam */}
      {[-3, 3].map((x) => (
        <mesh key={x} position={[x, BEAM_Y - 0.55, 0.05]} material={mats.rail} castShadow>
          <torusGeometry args={[0.38, 0.04, 8, 28]} />
        </mesh>
      ))}
    </group>
  )
}

/* ------------------------------------------------------------------ */
/*  Boundary fence receding into the fog on both sides                 */
/* ------------------------------------------------------------------ */

function BoundaryFence({ side, mats }: { side: 1 | -1; mats: Mats }) {
  const LENGTH = 38
  const START = 7.0
  const FENCE_H = 3.3

  const bars = useMemo<BarSpec[]>(() => {
    const list: BarSpec[] = []
    const n = Math.floor(LENGTH / 0.52)
    for (let i = 0; i < n; i += 1) {
      if (rand(i, side + 3) < 0.07) continue // missing bar
      const broken = rand(i, side + 9) < 0.08
      list.push({
        x: START + i * 0.52 + 0.2,
        y0: 0.5,
        y1: 0.5 + FENCE_H - (broken ? 0.9 : 0) - rand(i, 5) * 0.12,
        tilt: broken ? (rand(i, 6) - 0.5) * 0.35 : (rand(i, 4) - 0.5) * 0.02,
        finial: !broken,
      })
    }
    return list
  }, [side])

  const posts = useMemo(() => Array.from({ length: 7 }, (_, i) => START + 0.3 + i * 5.7), [])

  return (
    <group position={[0, 0, GATE_Z]} scale={[side, 1, 1]}>
      <mesh position={[START + LENGTH / 2, 0.25, 0]} material={mats.stoneBlock} castShadow receiveShadow>
        <boxGeometry args={[LENGTH, 0.5, 0.6]} />
      </mesh>
      {[1.3, 3.25].map((y) => (
        <mesh key={y} position={[START + LENGTH / 2, y, 0]} material={mats.rail} castShadow>
          <boxGeometry args={[LENGTH, 0.1, 0.1]} />
        </mesh>
      ))}
      <InstancedBars bars={bars} mats={mats} radius={0.028} />
      {posts.map((x, i) => (
        <group key={i} position={[x, 0, 0]} rotation={[0, 0, (rand(i, side) - 0.5) * 0.04]}>
          <mesh position={[0, 2.1, 0]} material={mats.pillar} castShadow receiveShadow>
            <boxGeometry args={[0.55, 3.8 - (i % 3) * 0.4, 0.55]} />
          </mesh>
          <mesh position={[0, 4.1 - (i % 3) * 0.4, 0]} material={mats.stoneBlock} castShadow>
            <sphereGeometry args={[0.3, 12, 8]} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

/* ------------------------------------------------------------------ */

export function CemeteryGate() {
  const mats = useGateMaterials()
  return (
    <group>
      <Pillar x={-6.15} mats={mats} lean={0.006} />
      <Pillar x={6.15} mats={mats} lean={-0.012} />
      <Overthrow mats={mats} />
      <GateLeaf side="left" mats={mats} />
      <GateLeaf side="right" mats={mats} />
      <BoundaryFence side={1} mats={mats} />
      <BoundaryFence side={-1} mats={mats} />
    </group>
  )
}
