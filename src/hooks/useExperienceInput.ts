import { useEffect } from 'react'
import { moveRoam, nudgeScroll, seq, turnRoam } from '../animations/sequence'
import { unlockAudio } from '../audio/audioManager'

/**
 * Wheel / touch / keyboard are converted into "virtual scroll": the page itself
 * never scrolls. Each input only moves a target; GSAP glides the real value.
 */
export function useExperienceInput() {
  useEffect(() => {
    const gesture = () => unlockAudio()
    let dragging = false
    let dragX = 0
    let dragY = 0

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 600 : 1
      const delta = Math.max(-180, Math.min(180, e.deltaY * unit))
      if (seq.exploration.entered) {
        if (seq.exploration.storyStarted) return
        // Inside the cemetery, the wheel is the walking stick: it moves along
        // the look direction instead of scrubbing the gate camera rail.
        // Scrolling down walks forward into the cemetery. The opening rail is
        // locked at the threshold, so a fast wheel cannot skip the discovery.
        moveRoam(0, -delta * 0.008)
        return
      }
      nudgeScroll(delta * 0.00055)
    }

    const onKey = (e: KeyboardEvent) => {
      const movement: Record<string, keyof typeof seq.roam.input> = {
        w: 'forward', s: 'back', a: 'left', d: 'right',
        arrowleft: 'turnLeft', arrowright: 'turnRight',
      }
      const key = e.key.toLowerCase()
      if (seq.exploration.storyStarted) return
      const input = movement[key] ?? (seq.exploration.entered && key === 'arrowup' ? 'forward' : seq.exploration.entered && key === 'arrowdown' ? 'back' : undefined)
      if (input && (seq.exploration.entered || (seq.scroll >= 0.18 && seq.gateOpen > 0.3))) {
        e.preventDefault()
        unlockAudio()
        seq.roam.input[input] = true
        return
      }
      const down = ['ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)
      const up = ['ArrowUp', 'PageUp'].includes(e.key)
      if (!down && !up) return
      e.preventDefault()
      unlockAudio()
      nudgeScroll(down ? 0.1 : -0.1)
    }

    const onKeyUp = (e: KeyboardEvent) => {
      const movement: Record<string, keyof typeof seq.roam.input> = {
        w: 'forward', s: 'back', a: 'left', d: 'right',
        arrowleft: 'turnLeft', arrowright: 'turnRight',
      }
      const key = e.key.toLowerCase()
      const input = movement[key] ?? (key === 'arrowup' ? 'forward' : key === 'arrowdown' ? 'back' : undefined)
      if (input) seq.roam.input[input] = false
    }
    const onWindowBlur = () => {
      Object.keys(seq.roam.input).forEach((key) => {
        seq.roam.input[key as keyof typeof seq.roam.input] = false
      })
      dragging = false
    }

    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof HTMLCanvasElement) || e.button !== 0 || !seq.exploration.entered) return
      if (document.pointerLockElement !== e.target) {
        try {
          const lock = e.target.requestPointerLock?.()
          if (lock) void lock.catch(() => undefined)
        } catch {
          // Drag look remains available where pointer lock is not supported.
        }
      }
      dragging = true
      dragX = e.clientX
      dragY = e.clientY
    }
    const onPointerUp = () => { dragging = false }
    const onPointerLockChange = () => {
      if (!document.pointerLockElement) dragging = false
    }

    let lastY = 0
    let lastX = 0
    const onTouchStart = (e: TouchEvent) => {
      lastY = e.touches[0]?.clientY ?? 0
      lastX = e.touches[0]?.clientX ?? 0
    }
    const onTouchMove = (e: TouchEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('.explore-pad')) return
      e.preventDefault()
      const y = e.touches[0]?.clientY ?? lastY
      const x = e.touches[0]?.clientX ?? lastX
      if (seq.exploration.entered) {
        if (seq.exploration.storyStarted) return
        moveRoam(0, (lastY - y) * 0.009)
        turnRoam((lastX - x) * 0.006)
      } else {
        nudgeScroll((lastY - y) * 0.0034)
      }
      lastY = y
      lastX = x
    }
    const onTouchEnd = () => unlockAudio()

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      seq.pointer.x = (e.clientX / window.innerWidth - 0.5) * 2
      seq.pointer.y = -(e.clientY / window.innerHeight - 0.5) * 2
      if (document.pointerLockElement && seq.exploration.entered) {
        turnRoam(-e.movementX * 0.0022, -e.movementY * 0.0018)
        return
      }
      if (dragging) {
        turnRoam((dragX - e.clientX) * 0.0034, (dragY - e.clientY) * 0.0024)
        dragX = e.clientX
        dragY = e.clientY
      }
    }

    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerdown', gesture)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    document.addEventListener('pointerlockchange', onPointerLockChange)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', gesture)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [])
}
