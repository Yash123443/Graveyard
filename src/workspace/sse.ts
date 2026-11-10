/**
 * Incremental Server-Sent Events parser (WHATWG "event stream" rules).
 *
 * Feed decoded text chunks of any size with `push`. Handles LF, CRLF and CR
 * line endings (including a CRLF split across chunks), multi-line `data`,
 * comment lines (heartbeats), a leading BOM, and events split anywhere.
 * Pure and dependency-free so it can be checked in Node without a browser.
 */

export interface SseMessage {
  /** Last event id seen on the stream when this message was dispatched. */
  id: string | undefined
  event: string
  data: string
}

export interface SseParser {
  push(chunk: string): void
  /** Call when the stream ends; incomplete trailing events are discarded. */
  end(): void
}

export function createSseParser(onMessage: (message: SseMessage) => void, onComment?: (text: string) => void): SseParser {
  let buffer = ''
  let started = false
  let lastId: string | undefined
  let eventType = ''
  let dataLines: string[] = []

  const dispatch = () => {
    if (dataLines.length > 0) {
      onMessage({ id: lastId, event: eventType || 'message', data: dataLines.join('\n') })
    }
    eventType = ''
    dataLines = []
  }

  const processLine = (line: string) => {
    if (line === '') {
      dispatch()
      return
    }
    if (line.startsWith(':')) {
      onComment?.(line.slice(1))
      return
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') dataLines.push(value)
    else if (field === 'event') eventType = value
    else if (field === 'id') {
      if (!value.includes('\0')) lastId = value
    }
    // `retry` and unknown fields are intentionally ignored.
  }

  return {
    push(chunk: string) {
      buffer += chunk
      if (!started && buffer.length > 0) {
        started = true
        if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1)
      }
      let start = 0
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i]
        if (ch === '\n') {
          processLine(buffer.slice(start, i))
          start = i + 1
        } else if (ch === '\r') {
          // A trailing CR may be the first half of CRLF: wait for more input.
          if (i === buffer.length - 1) break
          processLine(buffer.slice(start, i))
          if (buffer[i + 1] === '\n') i++
          start = i + 1
        }
      }
      buffer = buffer.slice(start)
    },
    end() {
      // A lone trailing CR is a complete line ending once the stream is over.
      if (buffer.endsWith('\r')) processLine(buffer.slice(0, -1))
      buffer = ''
      eventType = ''
      dataLines = []
    },
  }
}
