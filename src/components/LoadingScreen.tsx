import { useProgress } from '@react-three/drei'
import { useEffect, useState } from 'react'

export function LoadingScreen({ onDone }: { onDone: () => void }) {
  const { active, progress } = useProgress()
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (!active && progress >= 100) {
      const timeout = window.setTimeout(() => {
        setVisible(false)
        onDone()
      }, 700)
      return () => window.clearTimeout(timeout)
    }
  }, [active, progress, onDone])

  // never trap the visitor on the loader if an asset stalls
  useEffect(() => {
    const t = window.setTimeout(() => {
      setVisible(false)
      onDone()
    }, 25000)
    return () => window.clearTimeout(t)
  }, [onDone])

  const pct = Math.min(100, Math.max(0, Math.round(progress)))
  const asset = pct < 35 ? 'Gathering the mist' : pct < 75 ? 'Lighting the lanterns' : 'The gates are waiting'

  return (
    <div className={`loading-screen ${visible ? '' : 'is-complete'}`} aria-hidden={!visible}>
      <div className="loading-screen__inner">
        <p className="eyebrow">GRAVEYARD</p>
        <div className="loading-meter" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span className="loading-meter__fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="loading-screen__meta">
          <span>{asset}</span>
          <span>{pct.toString().padStart(3, '0')}%</span>
        </div>
      </div>
    </div>
  )
}
