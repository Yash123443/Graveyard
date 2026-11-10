import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError, TERMINAL_EVENTS, TERMINAL_STATUSES, authHeaders, cancelJob, createJob, describeError, errorFrom, eventsUrl,
  getJob, isAbort, isTransient, type Credential, type JobMeta,
} from './api'
import { clearCredential, loadCredential, saveCredential } from './session'
import { createSseParser, type SseMessage } from './sse'

export type StreamState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed' | 'stopped'

export interface JobEvent {
  id: number
  type: string
  status?: string
  stage?: string
}

const MAX_EVENTS = 200
const isAuthFailure = (error: unknown) => error instanceof ApiError && (error.status === 401 || error.status === 403)

/** Owns the single current job: credential, metadata, SSE stream and actions. */
export function useRepairJob() {
  const [cred, setCred] = useState<Credential | null>(() => loadCredential())
  const [job, setJob] = useState<JobMeta | null>(null)
  const [events, setEvents] = useState<JobEvent[]>([])
  const [stream, setStream] = useState<StreamState>('idle')
  const [streamMessage, setStreamMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [busy, setBusy] = useState<'idle' | 'submitting' | 'cancelling'>('idle')
  const [reconnectKey, setReconnectKey] = useState(0)
  const busyRef = useRef(false)

  const reset = useCallback((message: string) => {
    clearCredential()
    setCred(null)
    setJob(null)
    setEvents([])
    setStream('idle')
    setStreamMessage('')
    setNotice(message)
  }, [])

  const jobId = cred?.jobId
  const token = cred?.token

  useEffect(() => {
    if (!jobId || !token) return
    const credential: Credential = { jobId, token }
    // Every (re)start replays from the beginning, so start from a clean list.
    setEvents([])
    const ac = new AbortController()
    const { signal } = ac
    const seen = new Set<number>()
    let lastId = 0
    let refreshing = false
    let again = false
    let streamTerminal = false
    let gotMessage = false

    // Coalesced status refresh: at most one request in flight, one queued.
    const refresh = async () => {
      if (refreshing) {
        again = true
        return
      }
      refreshing = true
      try {
        do {
          again = false
          try {
            const meta = await getJob(credential, signal)
            if (signal.aborted) return
            setJob(meta)
            setNotice('')
          } catch (error) {
            if (signal.aborted || isAbort(error)) return
            if (isAuthFailure(error)) {
              ac.abort()
              reset(describeError(error) + ' It was cleared from this tab.')
              return
            }
            setNotice(describeError(error))
          }
        } while (again && !signal.aborted)
      } finally {
        refreshing = false
      }
    }

    const onMessage = (message: SseMessage) => {
      if (signal.aborted) return
      const id = Number(message.id)
      if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) return
      seen.add(id)
      lastId = Math.max(lastId, id)
      gotMessage = true
      let status: string | undefined
      let stage: string | undefined
      try {
        const data: unknown = JSON.parse(message.data)
        if (data && typeof data === 'object') {
          const record = data as Record<string, unknown>
          if (typeof record.status === 'string') status = record.status
          if (typeof record.stage === 'string') stage = record.stage
        }
      } catch {
        // Payload is informational only; show the event type regardless.
      }
      setEvents((previous) => [...previous, { id, type: message.event, status, stage }].slice(-MAX_EVENTS))
      if (TERMINAL_EVENTS.includes(message.event)) streamTerminal = true
      void refresh()
    }

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, ms)
        signal.addEventListener('abort', done)
      })

    const run = async () => {
      let attempt = 0
      void refresh()
      while (!signal.aborted) {
        gotMessage = false
        try {
          setStream(attempt === 0 ? 'connecting' : 'reconnecting')
          const headers: Record<string, string> = { ...authHeaders(credential.token), Accept: 'text/event-stream' }
          if (lastId > 0) headers['Last-Event-ID'] = String(lastId)
          let res: Response
          try {
            res = await fetch(eventsUrl(credential.jobId), { headers, signal, cache: 'no-store' })
          } catch (error) {
            if (isAbort(error)) return
            throw new ApiError(0, 'network', true)
          }
          if (!res.ok) throw await errorFrom(res)
          if (!res.body) throw new ApiError(0, 'network', true)
          setStream('live')
          setStreamMessage('')
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          const parser = createSseParser(onMessage)
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              parser.push(decoder.decode(value, { stream: true }))
            }
            parser.push(decoder.decode())
            parser.end()
          } finally {
            void reader.cancel().catch(() => undefined)
          }
          if (signal.aborted) return
          if (streamTerminal) {
            setStream('closed')
            void refresh()
            return
          }
          // The server only ends a stream after a terminal event; anything
          // else is an interruption, so resume from the last seen id.
        } catch (error) {
          if (signal.aborted || isAbort(error)) return
          const failure = error instanceof ApiError ? error : new ApiError(0, 'network', true)
          if (!isTransient(failure)) {
            if (isAuthFailure(failure)) {
              ac.abort()
              reset(describeError(failure) + ' It was cleared from this tab.')
            } else {
              setStream('stopped')
              setStreamMessage(failure.status === 422 ? 'The live feed could not resume from the saved position.' : describeError(failure))
            }
            return
          }
        }
        attempt = gotMessage ? 1 : attempt + 1
        setStream('reconnecting')
        await sleep(Math.min(15000, 1000 * 2 ** (attempt - 1)) + Math.random() * 250)
      }
    }

    void run()
    return () => ac.abort()
  }, [jobId, token, reconnectKey, reset])

  const submit = useCallback(async (repoUrl: string) => {
    if (busyRef.current) return false
    busyRef.current = true
    setBusy('submitting')
    setSubmitError('')
    try {
      const created = await createJob(repoUrl)
      const stored = saveCredential(created)
      setJob(null)
      setEvents([])
      setNotice(stored ? '' : 'This browser blocked session storage, so the job cannot be restored after a reload.')
      setCred(created)
      return true
    } catch (error) {
      setSubmitError(describeError(error))
      return false
    } finally {
      busyRef.current = false
      setBusy('idle')
    }
  }, [])

  const cancel = useCallback(async () => {
    if (!cred || busyRef.current) return
    busyRef.current = true
    setBusy('cancelling')
    try {
      setJob(await cancelJob(cred))
      setNotice('')
    } catch (error) {
      if (isAuthFailure(error)) {
        reset(describeError(error) + ' It was cleared from this tab.')
      } else {
        setNotice(describeError(error))
        if (error instanceof ApiError && error.status === 409) {
          try {
            setJob(await getJob(cred))
          } catch {
            // Keep the conflict message; the live stream will refresh status.
          }
        }
      }
    } finally {
      busyRef.current = false
      setBusy('idle')
    }
  }, [cred, reset])

  const forget = useCallback(() => reset(''), [reset])
  const reconnect = useCallback(() => setReconnectKey((key) => key + 1), [])

  const terminal = !!job && TERMINAL_STATUSES.includes(job.status)
  return { hasJob: !!cred, jobId, job, events, stream, streamMessage, notice, submitError, busy, terminal, submit, cancel, forget, reconnect }
}
