import { useMemo } from 'react'
import * as THREE from 'three'

const fenceSections = [
  { position: [-27, 0, -17] as [number, number, number], rotation: 0.12, length: 7, bars: 5 },
  { position: [27, 0, -22] as [number, number, number], rotation: -0.2, length: 8, bars: 6 },
  { position: [26, 0, -46] as [number, number, number], rotation: 0.48, length: 9, bars: 5 },
  { position: [-28, 0, -56] as [number, number, number], rotation: -0.35, length: 10, bars: 7 },
]

function FenceSection({ position, rotation, length, bars }: (typeof fenceSections)[number]) {
  const barPositions = useMemo(() => {
    return Array.from({ length: bars }, (_, index) => -length / 2 + 0.75 + index * ((length - 1.5) / Math.max(1, bars - 1)))
  }, [bars, length])

  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[-length / 2, 1.05, 0]} castShadow>
        <cylinderGeometry args={[0.12, 0.16, 2.1, 10]} />
        <meshStandardMaterial color="#171b1c" roughness={0.86} metalness={0.72} />
      </mesh>
      <mesh position={[length / 2, 0.92, 0]} rotation={[0, 0, 0.11]} castShadow>
        <cylinderGeometry args={[0.12, 0.17, 1.84, 10]} />
        <meshStandardMaterial color="#1b1d1e" roughness={0.9} metalness={0.68} />
      </mesh>
      <mesh position={[0, 1.43, 0]} rotation={[0, 0, -0.03]} castShadow>
        <boxGeometry args={[length, 0.1, 0.1]} />
        <meshStandardMaterial color="#1c2022" roughness={0.85} metalness={0.78} />
      </mesh>
      <mesh position={[0, 0.64, 0]} rotation={[0, 0, -0.05]} castShadow>
        <boxGeometry args={[length * 0.92, 0.08, 0.09]} />
        <meshStandardMaterial color="#1c2022" roughness={0.9} metalness={0.7} />
      </mesh>
      {barPositions.map((x, index) => (
        <mesh key={index} position={[x, index % 2 ? 1.02 : 1.16, index % 3 === 0 ? 0.08 : -0.03]} rotation={[0.05 * (index % 2 ? 1 : -1), 0, index % 3 === 0 ? 0.08 : -0.03]} castShadow>
          <cylinderGeometry args={[0.035, 0.045, 1.7 - (index % 3) * 0.22, 7]} />
          <meshStandardMaterial color="#15191a" roughness={0.82} metalness={0.82} />
        </mesh>
      ))}
      <mesh position={[length * 0.18, 0.26, 0.03]} rotation={[0.2, 0.2, -0.26]}>
        <sphereGeometry args={[0.36, 12, 8]} />
        <meshStandardMaterial color="#26352f" roughness={1} />
      </mesh>
    </group>
  )
}

export function FenceLine() {
  return (
    <group>
      {fenceSections.map((section, index) => (
        <FenceSection key={index} {...section} />
      ))}
    </group>
  )
}
