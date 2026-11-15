import { useState } from 'react'
import { diffFileName, type ResultModel, type StageRow } from './result'

/** Saves plain text through a client-side Blob. Nothing is uploaded; the URL is revoked right away. */
function saveTextFile(name: string, text: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    return true
  } catch {
    return false
  }
}

function Stages({ title, rows }: { title: string; rows: StageRow[] }) {
  if (rows.length === 0) return null
  return (
    <div className="ws-substage">
      <h3>{title}</h3>
      <ol className="ws-runstages">
        {rows.map((row) => (
          <li key={row.stage} className={`ws-runstage ws-runstage--${row.status}`}>
            <b>{row.stage}</b>
            <span>{row.status}</span>
            {row.exitCode !== null && row.exitCode !== 0 && <em>exit {row.exitCode}</em>}
            {row.durationMs !== null && <small>{Math.round(row.durationMs)} ms</small>}
          </li>
        ))}
      </ol>
    </div>
  )
}

export default function ResultPanel({ model, jobId }: { model: ResultModel; jobId: string }) {
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState(false)
  const v = model.verification

  const onSave = () => {
    if (model.verifiedDiff === null) return
    const ok = saveTextFile(diffFileName(jobId), model.verifiedDiff)
    setSaved(ok)
    setSaveError(ok ? '' : 'This browser blocked the download. Select the diff below and copy it instead.')
  }

  return (
    <div className="ws-result">
      <p className={`ws-verdict ws-verdict--${model.tone}`} role="status">
        <strong>{model.headline}</strong>
      </p>
      <p>{model.summary}</p>

      {model.infrastructure && <p className="ws-hint">{model.infrastructure}</p>}
      {model.findings.length > 0 && (
        <ul className="ws-findings" aria-label="Findings">
          {model.findings.map((f) => <li key={f}>{f}</li>)}
        </ul>
      )}

      <Stages title="Original run (offline, network none)" rows={model.baselineStages} />
      <Stages title="Patched disposable copy (offline, network none)" rows={model.patchedStages} />

      {model.diagnosis && (
        <div className="ws-substage">
          <h3>Diagnosis <small>model-authored, not proven</small></h3>
          <p><b>{model.diagnosis.category}</b> · confidence {model.diagnosis.confidence}</p>
          <p>{model.diagnosis.summary}</p>
          <p className="ws-muted">{model.diagnosis.rootCause}</p>
          {model.diagnosis.files.length > 0 && <p className="ws-hint">Files: {model.diagnosis.files.join(', ')}</p>}
        </div>
      )}

      {v && (
        <div className="ws-substage">
          <h3>Verification <small>measured separately</small></h3>
          <dl className="ws-facts">
            <div><dt>Result</dt><dd>{v.status}{v.reason ? ` (${v.reason})` : ''}</dd></div>
            {v.measuredMs !== null && <div><dt>Measured</dt><dd>{(v.measuredMs / 1000).toFixed(1)} s total on the host</dd></div>}
            {v.pipelineMs !== null && <div><dt>Container</dt><dd>{(v.pipelineMs / 1000).toFixed(1)} s</dd></div>}
          </dl>
          {v.detail && <p className="ws-muted">{v.detail}</p>}
        </div>
      )}

      {model.proposal && (
        <div className="ws-substage">
          <h3>
            {model.verified ? 'Verified diff' : 'Patch proposal'}{' '}
            <small>
              {model.verified
                ? 'applied to a disposable copy only'
                : model.outcome === 'patch-failed-verification'
                  ? 'tested in a disposable copy, still failing, not applied'
                  : 'unverified, not applied'}
            </small>
          </h3>
          {model.proposal.summary && <p>{model.proposal.summary}</p>}
          <p className="ws-hint">
            {model.proposal.files.join(', ')}
            {model.proposal.added !== null && model.proposal.removed !== null && ` · +${model.proposal.added} −${model.proposal.removed}`}
          </p>
          <pre className="ws-diff" tabIndex={0} aria-label="Unified diff">{model.proposal.diff}</pre>
        </div>
      )}

      {model.verifiedDiff !== null && (
        <div className="ws-actions">
          <button className="ws-button" type="button" onClick={onSave}>Save verified diff</button>
          <span className="ws-hint" role="status">
            {saved ? 'Saved as plain text.' : 'Plain text. Apply it yourself, then re-run your own tests.'}
          </span>
        </div>
      )}
      {saveError && <p className="ws-error" role="alert">{saveError}</p>}

      {model.notes.length > 0 && (
        <ul className="ws-notes" aria-label="Notes">
          {model.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </div>
  )
}
