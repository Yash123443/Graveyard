import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'

/** Sample sustained frame time, with hysteresis so resolution never oscillates every frame. */
export function AdaptiveRendering() {
  const setDpr = useThree(state => state.setDpr)
  const setFrameloop = useThree(state => state.setFrameloop)
  useEffect(() => {
    const visibility = () => setFrameloop(document.hidden ? 'never' : 'always')
    document.addEventListener('visibilitychange', visibility)
    visibility()
    return () => { document.removeEventListener('visibilitychange', visibility); setFrameloop('always') }
  }, [setFrameloop])
  const sample = useRef({ seconds: 0, frames: 0, warmup: 0, dpr: 1, fastWindows: 0 })
  useFrame((_, delta) => {
    const s = sample.current
    if (document.hidden || delta > 0.25) { s.seconds = 0; s.frames = 0; return }
    s.warmup += delta
    if (s.warmup < 4) return
    s.seconds += delta; s.frames++
    if (s.seconds < 3) return
    const fps = s.frames / s.seconds
    s.fastWindows = fps > 57 ? s.fastWindows + 1 : 0
    const ceiling = Math.min(window.devicePixelRatio || 1, 1.25)
    const next = fps < 42 ? Math.max(0.7, s.dpr - 0.15)
      : s.fastWindows >= 3 ? Math.min(ceiling, s.dpr + 0.1) : s.dpr
    if (next !== s.dpr) { setDpr(next); s.dpr = next; s.fastWindows = 0 }
    s.seconds = 0; s.frames = 0
  })
  return null
}
