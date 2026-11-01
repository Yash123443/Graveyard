import { useGLTF } from '@react-three/drei'
import type { ThreeElements } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'

type ModelAssetProps = ThreeElements['group'] & {
  url: string
}

export function ModelAsset({ url, ...props }: ModelAssetProps) {
  const { scene } = useGLTF(url)
  const clone = useMemo(() => scene.clone(true), [scene])

  useEffect(() => {
    clone.traverse((child) => {
      child.castShadow = true
      child.receiveShadow = true
    })
  }, [clone])

  return <primitive object={clone} {...props} />
}
