import { Suspense, useCallback, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { ACESFilmicToneMapping, PCFSoftShadowMap, SRGBColorSpace } from 'three'
import { GraveyardScene } from './scenes/GraveyardScene'
import { LoadingScreen } from './components/LoadingScreen'
import { OpeningOverlay } from './components/OpeningOverlay'
import { useExperienceInput } from './hooks/useExperienceInput'
import { preloadAudio } from './audio/audioManager'

preloadAudio()

export default function App() {
  const [ready, setReady] = useState(false)
  const onLoaded = useCallback(() => setReady(true), [])
  useExperienceInput()

  return (
    <main className="experience-shell">
      <Canvas
        shadows={{ type: PCFSoftShadowMap }}
        dpr={[1, 1.25]}
        camera={{ position: [0, 2.1, 37], fov: 46, near: 0.1, far: 700 }}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        onCreated={({ gl, scene }) => {
          gl.outputColorSpace = SRGBColorSpace
          gl.toneMapping = ACESFilmicToneMapping
          gl.toneMappingExposure = 1.2
          scene.background = null
        }}
      >
        <color attach="background" args={['#000000']} />
        <fogExp2 attach="fog" args={['#120d08', 0.0105]} />
        <Suspense fallback={null}>
          <GraveyardScene />
        </Suspense>
      </Canvas>
      <OpeningOverlay ready={ready} />
      <LoadingScreen onDone={onLoaded} />
    </main>
  )
}
