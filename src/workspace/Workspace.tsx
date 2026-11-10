import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { checkHealth, looksLikeRepoUrl } from './api'
import { useRepairJob, type StreamState } from './useRepairJob'
import './workspace.css'

const STAGES = ['queued', 'cloning', 'analyzing', 'diagnosing', 'repairing', 'building', 'testing', 'verifying'] as const

const ROLES = [
  { name: 'Analyst', tone: 'analyst', stages: ['analyzing', 'diagnosing'], duty: 'Investigates the repository and locates the cause.' },
  { name: 'Fixer', tone: 'fixer', stages: ['repairing'], duty: 'Repairs the broken dependencies.' },
  { name: 'Tester', tone: 'tester', stages: ['building', 'testing', 'verifying'], duty: 'Builds and tests before anything is called alive.' },
] as const

type Health = { state: 'checking' } | { state: 'online'; version: string } | { state: 'offline' }

function HealthBadge() {
  const [health, setHealth] = useState<Health>({ state: 'checking' })
  useEffect(() => {
    const ac = new AbortController()
    const probe = () => {
      checkHealth(ac.signal).then(
        ({ version }) => { if (!ac.signal.aborted) setHealth({ state: 'online', version }) },
        () => { if (!ac.signal.aborted) setHealth({ state: 'offline' }) },
      )
    }
    probe()
    const timer = window.setInterval(probe, 15000)
    return () => {
      ac.abort()
      window.clearInterval(timer)
    }
  }, [])
  const text = health.state === 'online' ? `Backend online · v${health.version}` : health.state === 'offline' ? 'Backend unreachable' : 'Checking backend…'
  return (
    <span className={`ws-badge ws-badge--${health.state}`} role="status">
      <i aria-hidden="true" />
      {text}
    </span>
  )
}

const streamText: Record<StreamState, string> = {
  idle: 'No live feed',
  connecting: 'Connecting to live feed…',
  live: 'Live feed connected',
  reconnecting: 'Live feed interrupted · retrying',
  closed: 'Feed closed · job finished',
  stopped: 'Live feed stopped',
}

export default function Workspace() {
  const repo = useRepairJob()
  const { job } = repo
  const [url, setUrl] = useState('')
  const [consent, setConsent] = useState(false)
  const [touched, setTouched] = useState(false)
  const main = useRef<HTMLElement>(null)
  const ids = { url: useId(), hint: useId(), consent: useId() }

  useEffect(() => {
    const previous = document.title
    document.title = 'Repair Workspace — GRAVEYARD'
    return () => { document.title = previous }
  }, [])

  const trimmed = url.trim()
  const urlValid = looksLikeRepoUrl(trimmed.replace(/\.git$/, ''))
  const canSubmit = urlValid && consent && repo.busy === 'idle' && !repo.hasJob

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (!canSubmit) return
    if (await repo.submit(trimmed)) {
      setUrl('')
      setConsent(false)
      setTouched(false)
    }
  }

  const running = job?.status === 'running'
  const activeStage = job ? STAGES.findIndex((s) => s === job.stage) : -1

  return (
    <div className="ws-scroll">
      <button type="button" className="ws-skip" onClick={() => main.current?.focus()}>Skip to workspace</button>
      <header className="ws-header">
        <div>
          <p className="ws-eyebrow">GRAVEYARD · RESEARCH DESK</p>
          <h1>Repair Workspace</h1>
        </div>
        <nav className="ws-nav" aria-label="Workspace">
          <HealthBadge />
          <a className="ws-link" href={`${window.location.pathname}${window.location.search}`}>Return to the cemetery</a>
        </nav>
      </header>

      <main ref={main} tabIndex={-1} className="ws-main" aria-label="Repair workspace">
        <section className="ws-notice" aria-label="Current capabilities">
          <strong>Honest status.</strong> The backend accepts and stores jobs, but worker execution is not enabled yet. Queued jobs stay
          queued until you cancel them, and no result or patch endpoint exists, so nothing is repaired here yet.
        </section>

        <div className="ws-grid">
          <section className="ws-card" aria-labelledby="ws-submit-title">
            <h2 id="ws-submit-title">Open a case</h2>
            <form onSubmit={onSubmit} noValidate>
              <label htmlFor={ids.url}>Public GitHub repository URL</label>
              <input
                id={ids.url}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://github.com/owner/repo"
                value={url}
                disabled={repo.hasJob}
                aria-invalid={touched && !urlValid}
                aria-describedby={ids.hint}
                onChange={(e) => setUrl(e.target.value)}
              />
              <p id={ids.hint} className={touched && !urlValid ? 'ws-hint ws-hint--error' : 'ws-hint'}>
                {touched && !urlValid ? 'Enter a URL like https://github.com/owner/repo.' : 'Public repositories only. No GitHub login is needed.'}
              </p>
              <div className="ws-check">
                <input id={ids.consent} type="checkbox" checked={consent} disabled={repo.hasJob} onChange={(e) => setConsent(e.target.checked)} />
                <label htmlFor={ids.consent}>
                  I consent to this service cloning and analysing this public repository. I understand no repair result is produced yet.
                </label>
              </div>
              <button className="ws-button" type="submit" disabled={repo.hasJob || repo.busy !== 'idle'}>
                {repo.busy === 'submitting' ? 'Submitting…' : 'Submit for repair'}
              </button>
              {touched && !consent && <p className="ws-hint ws-hint--error" role="alert">Consent is required before submitting.</p>}
              {repo.hasJob && <p className="ws-hint">A job is already open in this tab. Finish or forget it to open another.</p>}
              {repo.submitError && <p className="ws-error" role="alert">{repo.submitError}</p>}
            </form>
          </section>

          <section className="ws-card" aria-labelledby="ws-job-title">
            <h2 id="ws-job-title">Current job</h2>
            {!repo.hasJob && <p className="ws-muted">No job in this tab.</p>}
            {repo.hasJob && !job && !repo.notice && <p className="ws-muted" role="status">Loading job details…</p>}
            {job && (
              <dl className="ws-facts">
                <div><dt>Repository</dt><dd>{job.repoUrl}</dd></div>
                <div><dt>Status</dt><dd><span className={`ws-status ws-status--${job.status}`}>{job.status}</span></dd></div>
                <div><dt>Stage</dt><dd>{job.stage}</dd></div>
                <div><dt>Created</dt><dd><time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time></dd></div>
                <div><dt>Updated</dt><dd><time dateTime={job.updatedAt}>{new Date(job.updatedAt).toLocaleString()}</time></dd></div>
              </dl>
            )}
            {repo.notice && <p className="ws-error" role="alert">{repo.notice}</p>}
            {repo.hasJob && (
              <div className="ws-actions">
                {job?.status === 'queued' && (
                  <button className="ws-button ws-button--danger" type="button" disabled={repo.busy !== 'idle'} onClick={() => void repo.cancel()}>
                    {repo.busy === 'cancelling' ? 'Cancelling…' : 'Cancel queued job'}
                  </button>
                )}
                {(repo.terminal || (!job && repo.notice)) && (
                  <button className="ws-button ws-button--quiet" type="button" onClick={repo.forget}>Clear job from this tab</button>
                )}
              </div>
            )}
            {repo.hasJob && job?.status === 'queued' && <p className="ws-hint">Cancel it before clearing: the access token exists only in this tab.</p>}
          </section>
        </div>

        <section className="ws-card" aria-labelledby="ws-stage-title">
          <h2 id="ws-stage-title">Stage timeline</h2>
          <ol className="ws-stages">
            {STAGES.map((stage, index) => {
              const current = index === activeStage
              return (
                <li key={stage} className={current ? 'is-current' : ''} aria-current={current ? 'step' : undefined}>
                  <span>{stage}</span>
                  {current && <small>{job?.status ?? ''}</small>}
                </li>
              )
            })}
          </ol>
          <p className="ws-hint">Only the stage reported by the backend is marked. Nothing is inferred or simulated.</p>
        </section>

        <section className="ws-card" aria-labelledby="ws-roles-title">
          <h2 id="ws-roles-title">Agents</h2>
          <ul className="ws-roles">
            {ROLES.map((role) => {
              const active = running && (role.stages as readonly string[]).includes(job?.stage ?? '')
              return (
                <li key={role.name} className={`ws-role ws-role--${role.tone}${active ? ' is-active' : ''}`}>
                  <b>{role.name}</b>
                  <span>{active ? 'Active' : 'Inactive'}</span>
                  <p>{role.duty}</p>
                </li>
              )
            })}
          </ul>
        </section>

        <div className="ws-grid">
          <section className="ws-card" aria-labelledby="ws-events-title">
            <h2 id="ws-events-title">Event log</h2>
            <p className="ws-feed" role="status">
              {streamText[repo.stream]}
              {repo.stream === 'stopped' && <button className="ws-link ws-link--button" type="button" onClick={repo.reconnect}>Reconnect</button>}
            </p>
            {repo.streamMessage && <p className="ws-error" role="alert">{repo.streamMessage}</p>}
            {repo.events.length === 0 ? (
              <p className="ws-muted">No events received.</p>
            ) : (
              <ol className="ws-events" aria-label="Job events in order">
                {repo.events.map((e) => (
                  <li key={e.id}><span>#{e.id}</span><b>{e.type}</b>{e.status && <em>{e.status}</em>}</li>
                ))}
              </ol>
            )}
          </section>

          <section className="ws-card" aria-labelledby="ws-result-title">
            <h2 id="ws-result-title">Result</h2>
            <p className="ws-muted">No result is available. The backend has no result or patch endpoint yet, so nothing is shown here.</p>
          </section>
        </div>
      </main>
    </div>
  )
}
