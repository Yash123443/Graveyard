import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { groundHeight } from './Ground'
import { createStoneTextures } from '../utils/proceduralTextures'

/** Broken, half-buried flagstones quietly lead toward the final clearing. One draw call. */
export function ProcessionalPath() {
  const stones = useRef<THREE.InstancedMesh>(null)
  const textures = useMemo(() => createStoneTextures(128), [])
  useEffect(() => () => { textures.map.dispose(); textures.bumpMap.dispose() }, [textures])
  useLayoutEffect(() => {
    if (!stones.current) return
    const transform = new THREE.Object3D(), color = new THREE.Color()
    for (let i = 0; i < 32; i++) {
      const row = Math.floor(i / 2), side = i % 2 ? 1 : -1
      const x = side * (0.67 + Math.sin(i * 7.3) * 0.19), z = -12 - row * 3.7 + Math.sin(i * 2.1) * 0.25
      transform.position.set(x, groundHeight(x, z) - 0.06, z)
      transform.rotation.set(0, Math.sin(i * 17.2) * 0.23, 0)
      transform.scale.set(0.64 + (i % 3) * 0.055, 0.2, 0.82 + (i % 4) * 0.06)
      transform.updateMatrix(); stones.current.setMatrixAt(i, transform.matrix)
      stones.current.setColorAt(i, color.setHSL(0.14, 0.06, 0.34 + (i % 5) * 0.025))
    }
    stones.current.instanceMatrix.needsUpdate = true
    if (stones.current.instanceColor) stones.current.instanceColor.needsUpdate = true
    stones.current.computeBoundingSphere()
  }, [])
  return <instancedMesh ref={stones} args={[undefined, undefined, 32]} receiveShadow>
    <cylinderGeometry args={[1, 1.05, 1, 6]} />
    <meshStandardMaterial map={textures.map} bumpMap={textures.bumpMap} bumpScale={0.06} roughness={0.98} />
  </instancedMesh>
}
