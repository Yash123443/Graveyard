import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq } from '../animations/sequence'

const vertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const fragment = /* glsl */ `
  uniform float uReveal;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  varying vec3 vDir;
  void main() {
    float h = clamp(vDir.y, 0.0, 1.0);
    vec3 c = mix(uHorizon, uZenith, pow(h, 0.5));
    // cold glow concentrated toward the moon side of the sky (-z)
    float moonSide = smoothstep(-0.2, 1.0, -vDir.z) * (1.0 - h);
    c += vec3(0.05, 0.09, 0.14) * moonSide * 0.8;
    gl_FragColor = vec4(c * uReveal, 1.0);
  }
`

/** Gradient midnight sky. Unlit, ignores scene fog, fades in with the moon. */
export function Sky() {
  const material = useRef<THREE.ShaderMaterial>(null)
  const uniforms = useMemo(
    () => ({
      uReveal: { value: 0 },
      uHorizon: { value: new THREE.Color('#182a3e') },
      uZenith: { value: new THREE.Color('#01030a') },
    }),
    [],
  )
  useFrame(() => {
    uniforms.uReveal.value = seq.reveal.moon * (1 - seq.ending.moonFade)
  })
  return (
    <mesh renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[420, 32, 24]} />
      <shaderMaterial ref={material} uniforms={uniforms} vertexShader={vertex} fragmentShader={fragment} side={THREE.BackSide} depthWrite={false} fog={false} toneMapped={false} />
    </mesh>
  )
}
