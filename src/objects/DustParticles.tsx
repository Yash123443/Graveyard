import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'

export function DustParticles() {
  const pointsRef = useRef<THREE.Points>(null)
  const geometry = useMemo(() => {
    const positions = new Float32Array(720 * 3)
    for (let index = 0; index < 720; index += 1) {
      positions[index * 3] = Math.sin(index * 13.71) * 34
      positions[index * 3 + 1] = 0.35 + (index % 61) * 0.17
      positions[index * 3 + 2] = -4 - ((index * 9.13) % 64)
    }
    const nextGeometry = new THREE.BufferGeometry()
    nextGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return nextGeometry
  }, [])

  useFrame(({ clock }) => {
    if (!pointsRef.current) return
    pointsRef.current.rotation.y = clock.elapsedTime * 0.006
    pointsRef.current.position.y = Math.sin(clock.elapsedTime * 0.18) * 0.08
  })

  return (
    <points ref={pointsRef} geometry={geometry}>
      <pointsMaterial color="#c7d9e6" size={0.075} transparent opacity={0.45} sizeAttenuation depthWrite={false} />
    </points>
  )
}
