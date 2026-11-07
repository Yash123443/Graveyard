import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { batchStaticMeshes } from '../utils/batchStaticMeshes'
import { seq } from '../animations/sequence'

/** Broad branch dressing: draped cobwebs, bat garlands, hanging skulls, and amber bulbs. */
export function TreeCanopyDecor({ position, index }: { position: [number, number, number]; index: number }) {
  const { root, materials, webGeometry } = useMemo(() => {
    const root = new THREE.Group()
    const charcoal = new THREE.MeshStandardMaterial({ color: '#292d35', emissive: '#475260', emissiveIntensity: 0.12, roughness: 0.9 })
    const cord = new THREE.MeshStandardMaterial({ color: '#5a5145', roughness: 1 })
    const bone = new THREE.MeshStandardMaterial({ color: '#aba38d', emissive: '#3b4650', emissiveIntensity: 0.25, roughness: 0.95 })
    const amber = new THREE.MeshBasicMaterial({ color: '#e9a25c', toneMapped: false })
    const silk = new THREE.LineBasicMaterial({ color: '#8ea3ad', transparent: true, opacity: 0.45, depthWrite: false })
    const add = (g: THREE.BufferGeometry, m: THREE.Material, p: number[]) => { const mesh = new THREE.Mesh(g, m); mesh.position.set(p[0], p[1], p[2]); root.add(mesh); return mesh }
    const string = (points: THREE.Vector3[]) => add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 32, 0.017, 4, false), cord, [0, 0, 0])
    const height = 4.8 + (index % 3) * 0.6
    string([new THREE.Vector3(-3.8, height + 0.9, 0), new THREE.Vector3(-1.7, height - 0.1, 0.3), new THREE.Vector3(1.4, height - 0.2, 0.4), new THREE.Vector3(3.8, height + 1, 0)])
    const batShape = new THREE.Shape()
    batShape.moveTo(0, 0.12); batShape.lineTo(-0.08, 0.25); batShape.lineTo(-0.13, 0.08)
    batShape.bezierCurveTo(-0.25, 0.25, -0.52, 0.32, -0.64, 0.28)
    batShape.quadraticCurveTo(-0.48, 0.08, -0.48, -0.09); batShape.quadraticCurveTo(-0.32, 0.02, -0.26, -0.18)
    batShape.quadraticCurveTo(-0.12, -0.05, 0, -0.25)
    batShape.quadraticCurveTo(0.12, -0.05, 0.26, -0.18); batShape.quadraticCurveTo(0.32, 0.02, 0.48, -0.09)
    batShape.quadraticCurveTo(0.48, 0.08, 0.64, 0.28); batShape.bezierCurveTo(0.52, 0.32, 0.25, 0.25, 0.13, 0.08)
    batShape.lineTo(0.08, 0.25); batShape.closePath()
    for (let i = 0; i < 9; i++) {
      const x = -3.3 + i * 0.82, y = height - 0.25 + (x * x) * 0.08
      add(new THREE.SphereGeometry(0.09, 8, 6), amber, [x, y, 0.35])
      if (i % 2 === 0) {
        const drop = 0.38 + (i % 3) * 0.15
        string([new THREE.Vector3(x, y, 0.35), new THREE.Vector3(x + 0.06, y - drop, 0.35)])
        const bat = add(new THREE.ExtrudeGeometry(batShape, { depth: 0.035, bevelEnabled: false, curveSegments: 5 }), charcoal, [x, y - drop - 0.16, 0.35])
        bat.scale.setScalar(0.7 + (i % 3) * 0.13); bat.rotation.z = Math.sin(i + index) * 0.2
      }
    }
    // Skull charms flank the garland, positioned at a readable height.
    for (const side of [-1, 1]) {
      const x = side * 2.5, y = height - 1.7
      string([new THREE.Vector3(x, height + 0.1, 0.2), new THREE.Vector3(x, y + 0.28, 0.2)])
      const skull = add(new THREE.SphereGeometry(0.23, 16, 12), bone, [x, y, 0.2]); skull.scale.set(0.85, 1, 0.8)
      add(new THREE.BoxGeometry(0.2, 0.16, 0.15), bone, [x, y - 0.2, 0.24])
      for (const eye of [-0.075, 0.075]) {
        const socket = add(new THREE.SphereGeometry(0.058, 10, 8), charcoal, [x + eye, y + 0.02, 0.366]); socket.scale.z = 0.25
      }
      const nose = add(new THREE.ConeGeometry(0.033, 0.07, 3), charcoal, [x, y - 0.075, 0.38]); nose.rotation.z = Math.PI
    }
    const segments: number[] = []
    for (const side of [-1, 1]) {
      const cx = side * 2.2, cy = height + 0.5, radius = 1.65
      const point = (a: number, r: number) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.72, -0.1]
      for (let i = 0; i < 14; i++) {
        const a = i / 14 * Math.PI * 2
        segments.push(...point(a, 0), ...point(a, radius))
        for (let ring = 1; ring <= 6; ring++) {
          const r = radius * ring / 6, next = a + Math.PI * 2 / 14
          segments.push(...point(a, r), ...point((a + next) / 2, r * 0.94), ...point((a + next) / 2, r * 0.94), ...point(next, r))
        }
      }
    }
    const webGeometry = new THREE.BufferGeometry(); webGeometry.setAttribute('position', new THREE.Float32BufferAttribute(segments, 3))
    root.add(new THREE.LineSegments(webGeometry, silk)); batchStaticMeshes(root)
    return { root, materials: [charcoal, cord, bone, amber, silk], webGeometry }
  }, [index])
  useFrame(({ camera, clock }) => {
    root.visible = seq.reveal.trees > 0.4 && Math.hypot(camera.position.x - position[0], camera.position.z - position[2]) < 65
    if (root.visible) root.rotation.z = Math.sin(clock.elapsedTime * 0.4 + index) * 0.008
  })
  useEffect(() => () => {
    root.traverse(node => { if (node instanceof THREE.Mesh) node.geometry.dispose() })
    webGeometry.dispose(); materials.forEach(material => material.dispose())
  }, [root, materials, webGeometry])
  return <group position={[position[0], position[1], position[2] + 1.6]}><primitive object={root} /></group>
}
