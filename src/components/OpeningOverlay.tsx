import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { moveRoam, startGuidedTour, skipToEnding, nudgeScroll, playIntro, seq, smoothstep, turnRoam } from '../animations/sequence'
import { getAudioStatus, subscribeAudio, toggleAudio, unlockAudio } from '../audio/audioManager'
import { getRepairResult } from '../integrations/repairResult'
import { graveStories } from '../objects/graveStories'
import { GRAVE_READING_SECONDS } from '../animations/graveEncounter'
import { soulCue, SOUL_STARTS } from '../animations/soulChoreography'

function SoundControl() {
  const status = useSyncExternalStore(subscribeAudio, getAudioStatus)
  const label = status === 'on' ? 'SOUND ON' : status === 'muted' ? 'SOUND OFF' : 'ENABLE SOUND'
  return (
    <button
      className={`audio-control audio-control--${status}`}
      type="button"
      aria-pressed={status === 'on'}
      aria-label={status === 'on' ? 'Mute atmosphere' : 'Unmute atmosphere'}
      onClick={() => {
        if (status === 'locked') unlockAudio()
        else toggleAudio()
      }}
    >
      <span className="audio-control__bars" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span>{label}</span>
    </button>
  )
}

/** DOM layer: darkness veil, title typography, chapter marks. Everything is driven by refs, not React state. */
export function OpeningOverlay({ ready }: { ready: boolean }) {
  const [githubNotice, setGithubNotice] = useState('')
  const veil = useRef<HTMLDivElement>(null)
  const copy = useRef<HTMLElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const tagline = useRef<HTMLParagraphElement>(null)
  const supporting = useRef<HTMLParagraphElement>(null)
  const cue = useRef<HTMLButtonElement>(null)
  const chrome = useRef<HTMLDivElement>(null)
  const chapter = useRef<HTMLSpanElement>(null)
  const meter = useRef<HTMLSpanElement>(null)
  const readingFill = useRef<HTMLSpanElement>(null)
  const readingLabel = useRef<HTMLSpanElement>(null)
  const exploreTitle = useRef<HTMLSpanElement>(null)
  const visited = useRef(new Set<number>())
  const graveRecord = useRef<HTMLDivElement>(null)
  const epitaph = useRef<HTMLParagraphElement>(null)
  const graveStoryLine = useRef<HTMLParagraphElement>(null)
  const agentPanel = useRef<HTMLDivElement>(null)
  const agentName = useRef<HTMLSpanElement>(null)
  const agentLine = useRef<HTMLParagraphElement>(null)
  const agentPurpose = useRef<HTMLSpanElement>(null)
  const timeline = useRef<HTMLDivElement>(null)
  const finale = useRef<HTMLElement>(null)
  const finaleHeadline = useRef<HTMLHeadingElement>(null)
  const finaleSubhead = useRef<HTMLParagraphElement>(null)
  const finaleStatus = useRef<HTMLParagraphElement>(null)
  const authNotice = useRef<HTMLParagraphElement>(null)
  const tourControls = useRef<HTMLDivElement>(null)
  const explorePad = useRef<HTMLDivElement>(null)
  const nearbyTrace = useRef<HTMLDivElement>(null)
  const nearbyName = useRef<HTMLElement>(null)
  const nearbyEpitaph = useRef<HTMLElement>(null)
  const nearbyStory = useRef<HTMLElement>(null)
  const nearbyCause = useRef<HTMLElement>(null)
  const lastNearby = useRef(-2)

  // start scene 1 only once the world has loaded
  useEffect(() => {
    if (!ready) return
    const tl = playIntro({
      title: title.current,
      tagline: tagline.current,
      supporting: supporting.current,
      cue: cue.current,
      chrome: chrome.current,
    })
    return () => {
      tl.kill()
    }
  }, [ready])

  // per-frame DOM sync (veil + scroll-linked typography)
  useEffect(() => {
    let raf = 0
    let lastChapter = ''
    const tick = () => {
      const repairResult = getRepairResult()
      if (veil.current) veil.current.style.opacity = String(seq.reveal.veil)
      const s = seq.scroll
      if (copy.current) {
        copy.current.classList.toggle('is-ready', seq.introDone)
        const out = smoothstep(0.0, 0.085, s)
        copy.current.style.opacity = String(1 - out)
        copy.current.style.transform = `translate3d(0, ${-out * 38}px, 0) scale(${1 + out * 0.06})`
        copy.current.style.filter = out > 0.01 ? `blur(${out * 6}px)` : 'none'
        copy.current.style.visibility = out >= 1 ? 'hidden' : 'visible'
      }
      if (meter.current) meter.current.style.transform = `scaleY(${seq.cam})`
      const mainFocus = smoothstep(0.25, 0.48, seq.exploration.nearMain)
      const recordIn = mainFocus
      const recordOut = 0
      if (readingFill.current) readingFill.current.style.transform = `scaleX(${Math.min(1, seq.exploration.readingSeconds / GRAVE_READING_SECONDS)})`
      if (readingLabel.current) readingLabel.current.textContent = seq.exploration.readingSeconds > 0 ? 'THE KEEPERS ARE LISTENING' : 'FACE THE GRAVE · PAUSE TO AWAKEN THE KEEPERS'
      const encounterFade = 1 - smoothstep(0, 0.035, seq.exploration.storyProgress)
      const storyFade = 1 - smoothstep(0.03, 0.22, seq.ending.progress)
      if (graveRecord.current) {
        graveRecord.current.style.opacity = String(recordIn * (1 - recordOut) * storyFade * encounterFade)
        graveRecord.current.style.transform = `translate3d(0, ${(1 - recordIn) * 20}px, 0)`
        for (let row = 2; row < 5; row++) {
          const element = graveRecord.current.children[row] as HTMLElement | undefined
          if (element) element.style.opacity = String(smoothstep(0.35 + (row - 2) * 0.115, 0.58 + (row - 2) * 0.115, seq.exploration.nearMain))
        }
      }
      if (epitaph.current) {
        const alpha = smoothstep(0.5, 0.9, seq.exploration.nearMain) * storyFade * encounterFade
        epitaph.current.style.opacity = String(alpha)
        // Preserve the CSS horizontal centering while the line rises in.
        epitaph.current.style.transform = `translate3d(-50%, ${(1 - alpha) * 12}px, 0)`
      }
      if (graveStoryLine.current) {
        const alpha = smoothstep(1.5, 3, seq.exploration.readingSeconds) * storyFade * encounterFade
        graveStoryLine.current.style.opacity = String(alpha)
      }
      if (tourControls.current) {
        const visible = ((seq.exploration.storyStarted && seq.exploration.storyProgress > 0.08) || (seq.guided && seq.exploration.entered && !seq.exploration.storyStarted && seq.exploration.nearMain < 0.75)) && !seq.ending.started
        tourControls.current.style.visibility = visible ? 'visible' : 'hidden'
        const action = tourControls.current.firstElementChild
        if (action) action.textContent = seq.exploration.storyStarted ? 'Skip to outcome' : 'Take control'
      }
      const story = seq.exploration.storyProgress
      const agent = story >= 0.48 ? 2 : story >= 0.24 ? 1 : 0
      const lines = ['Let me discover what killed it.', 'Let me bring it back.', 'But first, let me prove it\'s alive.']
      const statuses = ['ANALYST — INVESTIGATING', 'FIXER — REPAIRING', 'TESTER — VERIFYING']
      const purposes = [
        'Read the dependency history. Find the change that broke the build.',
        'Repair the broken dependencies. Rebuild what was left behind.',
        'Run the project’s build and tests before calling it alive.',
      ]
      const showAgent = soulCue(story, SOUL_STARTS[agent]).caption * storyFade
      if (agentPanel.current) {
        agentPanel.current.style.opacity = String(showAgent)
        agentPanel.current.style.transform = `translate3d(0, ${(1 - showAgent) * 18}px, 0)`
        agentPanel.current.style.borderColor = ['rgba(165,108,255,.7)', 'rgba(250,85,76,.75)', 'rgba(97,242,155,.75)'][agent]
      }
      if (agentName.current) agentName.current.style.color = ['#c5a2ff', '#ff8178', '#8ef5b7'][agent]
      if (agentName.current && agentName.current.textContent !== statuses[agent]) agentName.current.textContent = statuses[agent]
      if (agentLine.current && agentLine.current.textContent !== `“${lines[agent]}”`) agentLine.current.textContent = `“${lines[agent]}”`
      if (agentPurpose.current && agentPurpose.current.textContent !== purposes[agent]) agentPurpose.current.textContent = purposes[agent]
      if (timeline.current) timeline.current.style.opacity = String((agent === 0 ? smoothstep(0.12, 0.17, story) * (1 - smoothstep(0.21, 0.26, story)) : 0) * storyFade)
      const endingProgress = seq.ending.progress
      const finalAlpha = seq.ending.started ? smoothstep(seq.ending.outcome === 'success' ? 0.96 : 0.78, 1, endingProgress) : 0
      if (finale.current) { finale.current.style.opacity = String(finalAlpha); finale.current.style.visibility = finalAlpha > 0.01 ? 'visible' : 'hidden' }
      if (chrome.current && seq.ending.started) chrome.current.style.opacity = String(1 - smoothstep(0.78, 0.9, endingProgress))
      if (finaleHeadline.current) {
        finaleHeadline.current.textContent = seq.ending.outcome === 'success' ? 'IT’S ALIVE!' : 'THE GRAVE REMAINS CLOSED'
      }
      if (finaleSubhead.current) finaleSubhead.current.textContent = seq.ending.outcome === 'success'
        ? 'The project’s soul has returned. One more repository lives again.'
        : 'The repository’s state could not be verified.'
      if (finaleStatus.current) finaleStatus.current.textContent = seq.ending.outcome === 'pending'
        ? 'AWAITING BACKEND VERIFICATION'
        : seq.ending.outcome === 'success'
          ? 'REPAIR AND VERIFICATION CONFIRMED'
          : repairResult?.finalStatus === 'failed' || repairResult?.finalStatus === 'partial'
            ? `BACKEND STATUS: ${repairResult.finalStatus.toUpperCase()}`
            : 'REPAIR NOT VERIFIED · NO RESULT'
      if (explorePad.current) {
        explorePad.current.classList.toggle('is-reading', seq.exploration.nearMain > 0.75)
        const cinematicLock = smoothstep(0.01, 0.08, seq.exploration.storyProgress)
        const roamAlpha = Number(seq.exploration.entered) * (1 - cinematicLock) * (1 - smoothstep(0.75, 0.9, endingProgress))
        explorePad.current.style.opacity = String(roamAlpha)
        explorePad.current.style.visibility = roamAlpha > 0.01 ? 'visible' : 'hidden'
        explorePad.current.style.pointerEvents = roamAlpha > 0.3 ? 'auto' : 'none'
      }
      const graveIndex = seq.exploration.nearGrave
      if (graveIndex !== lastNearby.current) {
        lastNearby.current = graveIndex
        if (graveIndex >= 0) visited.current.add(graveIndex)
        const story = graveIndex >= 0 ? graveStories[graveIndex] : undefined
        if (nearbyName.current) nearbyName.current.textContent = story?.name || ''
        if (nearbyEpitaph.current) nearbyEpitaph.current.textContent = story ? `“${story.inscription}”` : ''
        if (nearbyStory.current) nearbyStory.current.textContent = story?.story || ''
        if (nearbyCause.current) nearbyCause.current.textContent = story ? `CAUSE · ${story.cause}` : ''
      }
      // Ordinary graves and the final grave never show two information panels
      // at once. The ordinary panel fades before the central record appears.
      const ordinaryFocus = Number(seq.exploration.entered && graveIndex >= 0) * seq.exploration.graveFocus * (1 - smoothstep(0.34, 0.5, seq.exploration.nearMain))
      if (nearbyTrace.current) {
        const panelFocus = ordinaryFocus * storyFade
        nearbyTrace.current.style.opacity = String(panelFocus)
      }
      if (exploreTitle.current) exploreTitle.current.textContent = seq.guided ? 'GUIDED WALK · FOLLOWING THE LANTERNS' : visited.current.size ? `MEMORIES FOUND · ${visited.current.size} / ${graveStories.length}` : 'EXPLORE THE GROUNDS'
      // Invisible narrative layers must also leave the accessibility tree.
      for (const panel of [graveRecord.current, epitaph.current, graveStoryLine.current, agentPanel.current, timeline.current, nearbyTrace.current]) {
        if (!panel) continue
        const hidden = Number(panel.style.opacity || 0) < 0.02
        panel.style.visibility = hidden ? 'hidden' : 'visible'
        panel.setAttribute('aria-hidden', String(hidden))
      }
      const next = seq.ending.started ? 'V — THE VERDICT' : seq.exploration.storyStarted ? 'IV — THE KEEPERS' : seq.exploration.nearMain > 0.75 ? 'III — THE FORGOTTEN GRAVE' : s < 0.5 ? 'I — THE GATE' : 'II — THE GROUNDS'
      if (chapter.current && next !== lastChapter) {
        chapter.current.textContent = next
        lastChapter = next
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <>
      <div ref={veil} className="opening-veil" aria-hidden="true" />
      <div className="screen-grade" aria-hidden="true" />

      <section ref={copy} className="opening-copy" aria-label="GRAVEYARD introduction">
        <h1 ref={title}><span className="opening-copy__edition">ALL HALLOWS’ EVE · ENTER AFTER DARK</span>GRAVEYARD</h1>
        <p ref={tagline} className="opening-copy__tagline">
          Every dead repo has a cause of death.
        </p>
        <p ref={supporting} className="opening-copy__supporting">
          Some repositories don&apos;t get deleted. They just stop breathing.
        </p>
        <button ref={cue} className="opening-copy__cue" type="button" onClick={() => nudgeScroll(0.54)} aria-label="Enter the graveyard">
          <span>ENTER THE GRAVEYARD</span>
          <span className="opening-copy__cue-line" aria-hidden="true" />
        </button>
        <button className="guided-entry" type="button" onClick={() => { unlockAudio(); startGuidedTour() }}>TAKE THE GUIDED TOUR <span>Follow the lanterns · read the grave · witness the ritual</span></button>
      </section>
      <div ref={tourControls} className="tour-controls" style={{ visibility: 'hidden' }}><button type="button" onClick={() => { if (seq.exploration.storyStarted) skipToEnding(); else seq.guided = false }}>Skip to outcome</button></div>

      <div ref={chrome} className="chrome" style={{ opacity: 0 }}>
        <span className="chrome__chapter" ref={chapter}>
          I — THE GATE
        </span>
        <span className="chrome__meter" aria-hidden="true">
          <span ref={meter} />
        </span>
      </div>
      <div ref={graveRecord} className="grave-record" aria-live="polite">
        <span className="grave-record__eyebrow">FOUND BENEATH THE TREE</span>
        <strong>OLD-PORTFOLIO</strong>
        <span>LAST ALIVE: 2019</span>
        <span>STATUS: ABANDONED</span>
        <span>CAUSE OF DEATH: UNKNOWN</span>
        <div className="reading-cue"><span ref={readingLabel}>FACE THE GRAVE · PAUSE TO AWAKEN THE KEEPERS</span><i aria-hidden="true"><span ref={readingFill} /></i></div>
      </div>
      <p ref={epitaph} className="grave-epitaph">“It wasn&apos;t abandoned. It was broken.”</p>
      <p ref={graveStoryLine} className="grave-story-line">A dependency update caused a chain reaction. The build failed, and the original cause remained undiscovered.<small>STAY AND READ · THE SOULS WILL AWAKEN · FICTIONAL DEMONSTRATION</small></p>
      <div ref={agentPanel} className="agent-dialogue" aria-live="polite">
        <span ref={agentName} className="agent-dialogue__name">ANALYST — INVESTIGATING</span>
        <p ref={agentLine}>“Let me discover what killed it.”</p>
        <span ref={agentPurpose} className="agent-dialogue__purpose">Reconstruct dependency history and locate the breaking release.</span>
      </div>
      <div ref={timeline} className="dependency-timeline" aria-label="Dependency investigation timeline">
        <span className="dependency-timeline__title">TRACING THE LAST KNOWN CHANGE</span>
        <div className="dependency-timeline__line"><i /><i /><i /><i /></div>
        <div className="dependency-timeline__labels"><span>ROOT CAUSE</span><span>DEPENDENCY</span><span>BREAKING CHANGE</span><span>VERIFICATION</span></div>
      </div>
      <div ref={explorePad} className="explore-pad" aria-label="Cemetery exploration controls">
        <span ref={exploreTitle} className="explore-pad__title">EXPLORE THE GROUNDS</span>
        <span className="explore-pad__guide"><b>W A S D</b> MOVE · <b>MOUSE</b> LOOK · <b>ESC</b> RELEASE</span>
        <span className="explore-pad__hint">Follow the lanterns to the old tree.</span>
        <div className="explore-pad__keys">
          <button type="button" aria-label="Look left" onClick={() => turnRoam(-0.18)}>↶</button>
          <button type="button" aria-label="Move forward" onClick={() => moveRoam(0, -2)}>↑</button>
          <button type="button" aria-label="Look right" onClick={() => turnRoam(0.18)}>↷</button>
          <button type="button" aria-label="Move left" onClick={() => moveRoam(-2, 0)}>←</button>
          <button type="button" aria-label="Move backward" onClick={() => moveRoam(0, 2)}>↓</button>
          <button type="button" aria-label="Move right" onClick={() => moveRoam(2, 0)}>→</button>
        </div>
      </div>
      <section ref={nearbyTrace} className="nearby-trace grave-story-panel" aria-live="polite" aria-label="Discovered grave story">
        <span className="grave-story-panel__eyebrow">DISCOVERED GRAVE · FICTIONAL CASE FILE</span>
        <strong ref={nearbyName}>THE UNFINISHED PROJECT · 01</strong>
        <em ref={nearbyEpitaph}>“Started with ambition. Never reached completion.”</em>
        <span ref={nearbyStory}>The developer began something ambitious, but left before its central features were finished.</span>
        <b ref={nearbyCause}>CAUSE · INCOMPLETE DEVELOPMENT</b>
        <small>FICTIONAL CEMETERY STORY</small>
      </section>
      <section ref={finale} className="finale" aria-live="polite">
        <p ref={finaleStatus} className="finale__status">AWAITING BACKEND VERIFICATION</p>
        <h2 ref={finaleHeadline}>THE GRAVE REMAINS CLOSED</h2>
        <p ref={finaleSubhead}>No verified repair result was received.</p>
        <div className="finale__last-word">EVERY DEAD REPO HAS A CAUSE OF DEATH.<span>Some deserve a second life.</span></div>
        <button className="github-connect" type="button" onClick={() => {
          const authUrl = import.meta.env.VITE_GITHUB_AUTH_URL
          if (!authUrl) {
            setGithubNotice('GitHub authentication is not configured yet.')
            return
          }
          try {
            const target = new URL(authUrl, window.location.origin)
            if (target.protocol !== 'https:' && target.origin !== window.location.origin) throw new Error('Unsupported authentication URL')
            window.location.assign(target.href)
          } catch {
            setGithubNotice('The configured GitHub authentication URL is invalid.')
          }
        }}>CONNECT WITH GITHUB</button>
        <button className="replay-experience" type="button" onClick={() => window.location.assign(window.location.pathname)}>EXPLORE AGAIN</button>
        <p ref={authNotice} className="finale__auth-notice">{githubNotice}</p>
      </section>
      <SoundControl />
    </>
  )
}
