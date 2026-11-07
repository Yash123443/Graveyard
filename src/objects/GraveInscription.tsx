import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq, smoothstep } from '../animations/sequence'

const lines = [
  { text: 'R . I . P .', y: 2.94, height: 0.18, font: 44, start: 0.1, end: 0.3 },
  { text: 'OLD-PORTFOLIO', y: 2.62, height: 0.32, font: 76, start: 0.16, end: 0.4 },
  { text: 'LAST ALIVE  ·  2019', y: 2.17, height: 0.24, font: 48, start: 0.35, end: 0.58 },
  { text: 'STATUS  ·  ABANDONED', y: 1.86, height: 0.24, font: 48, start: 0.46, end: 0.69 },
  { text: 'CAUSE OF DEATH  ·  UNKNOWN', y: 1.55, height: 0.24, font: 46, start: 0.58, end: 0.81 },
  { text: 'It wasn’t abandoned. It was broken.', y: 1.1, height: 0.25, font: 46, start: 0.75, end: 0.95 },
]

/** Separate, generously spaced inscriptions fade in without redrawing canvas textures each frame. */
export function GraveInscription() {
  const materials = useRef<(THREE.MeshBasicMaterial | null)[]>([])
  const textures = useMemo(() => lines.map((line, index) => {
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 128
    const ctx = canvas.getContext('2d')!
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.font = `${index === 5 ? 'italic' : '500'} ${line.font}px Georgia, serif`
    ctx.fillStyle = index === 1 ? '#e2e5da' : '#bcc8c9'
    ctx.fillText(line.text, 512, 64, 960)
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }), [])
  useEffect(() => () => textures.forEach(texture => texture.dispose()), [textures])
  useFrame(() => {
    const focus = seq.exploration.nearMain
    materials.current.forEach((material, index) => {
      if (material) material.opacity = smoothstep(lines[index].start, lines[index].end, focus) * 0.94
    })
  })
  return <group>{lines.map((line, i) => <mesh key={line.text} position={[0, line.y, 0.72]}>
    <planeGeometry args={[2.36, line.height]} />
    <meshBasicMaterial ref={material => { materials.current[i] = material }} map={textures[i]} transparent opacity={0} depthWrite={false} toneMapped={false} polygonOffset polygonOffsetFactor={-1} />
  </mesh>)}</group>
}
