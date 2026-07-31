import { describe, expect, it } from 'vitest'
import { MAX_BUFFERED_FRAME_CHARS, reconnectDelayMs, SseFrameDecoder } from '../../src/runtime/stream-reader'

/**
 * The daemon's SSE frame decoder and reconnect pacing. Both are pure, so these are ordinary unit
 * tests with no server, no socket and no timers.
 *
 * What they pin is the two ways this transport fails quietly: a frame split across a chunk boundary
 * (which loses runs only under load, exactly when it matters) and an unjittered reconnect (which
 * looks perfectly healthy until a backend deploy drops the whole fleet at once).
 */

describe('SseFrameDecoder', () => {
  it('decodes a named event with its data payload', () => {
    const decoder = new SseFrameDecoder()
    const frames = decoder.push('event: run\ndata: {"runId":"r1"}\n\n')
    expect(frames).toEqual([{ event: 'run', data: '{"runId":"r1"}' }])
  })

  it('reassembles a frame split ACROSS chunk boundaries', () => {
    const decoder = new SseFrameDecoder()
    // A chunk boundary falls wherever TCP decides - routinely mid-frame, and mid-line for the large
    // payloads (a run carrying a long prompt) that matter most.
    expect(decoder.push('event: ru')).toEqual([])
    expect(decoder.push('n\ndata: {"run')).toEqual([])
    expect(decoder.push('Id":"r1"}\n\n')).toEqual([{ event: 'run', data: '{"runId":"r1"}' }])
  })

  it('decodes several frames arriving in ONE chunk', () => {
    const decoder = new SseFrameDecoder()
    const frames = decoder.push('event: run\ndata: 1\n\nevent: cancel\ndata: 2\n\n')
    expect(frames).toEqual([
      { event: 'run', data: '1' },
      { event: 'cancel', data: '2' }
    ])
  })

  it('holds a partial trailing frame until its blank line arrives', () => {
    const decoder = new SseFrameDecoder()
    expect(decoder.push('event: run\ndata: 1\n\nevent: cancel\ndata: 2')).toEqual([
      { event: 'run', data: '1' }
    ])
    expect(decoder.push('\n\n')).toEqual([{ event: 'cancel', data: '2' }])
  })

  it('decodes a keep-alive comment frame', () => {
    const decoder = new SseFrameDecoder()
    expect(decoder.push(': keepalive\n\n')).toEqual([{ comment: 'keepalive' }])
  })

  it('joins a multi-line data payload with newlines, per the grammar', () => {
    const decoder = new SseFrameDecoder()
    expect(decoder.push('event: run\ndata: line1\ndata: line2\n\n')).toEqual([
      { event: 'run', data: 'line1\nline2' }
    ])
  })

  it('strips exactly ONE leading space after the colon, keeping the rest of the value', () => {
    const decoder = new SseFrameDecoder()
    // `data:  x` carries a value of ` x` - the first space is framing, the second is payload.
    expect(decoder.push('data:  x\n\n')).toEqual([{ data: ' x' }])
  })

  it('tolerates CRLF line endings from a proxy that rewrites them', () => {
    const decoder = new SseFrameDecoder()
    expect(decoder.push('event: run\r\ndata: 1\r\n\n')).toEqual([{ event: 'run', data: '1' }])
  })

  // A body that is CRLF THROUGHOUT ends its frames with `\r\n\r\n`, which contains no `\n\n` at all -
  // so a decoder looking only for the latter completes no frame on any chunk, ever. The device then
  // reads perfectly connected while receiving nothing: every run, cancel and instruction the backend
  // pushes is swallowed until the buffer hits its 32 MiB guard, whereupon the read loop throws, the
  // daemon reconnects, and it does the same thing again.
  it('decodes a frame terminated by a full CRLF blank line', () => {
    const decoder = new SseFrameDecoder()
    expect(decoder.push('event: run\r\ndata: {"runId":"r1"}\r\n\r\n')).toEqual([
      { event: 'run', data: '{"runId":"r1"}' }
    ])
  })

  it('decodes several CRLF frames arriving in ONE chunk', () => {
    const decoder = new SseFrameDecoder()
    expect(decoder.push('event: run\r\ndata: 1\r\n\r\nevent: cancel\r\ndata: 2\r\n\r\n')).toEqual([
      { event: 'run', data: '1' },
      { event: 'cancel', data: '2' }
    ])
  })

  it('reassembles a CRLF frame split inside its own terminator', () => {
    const decoder = new SseFrameDecoder()
    // The chunk boundary falls wherever TCP decides, including between the two CRLFs that end a frame.
    expect(decoder.push('event: run\r\ndata: 1\r\n\r')).toEqual([])
    expect(decoder.push('\n')).toEqual([{ event: 'run', data: '1' }])
  })

  it('decodes a CRLF keep-alive comment, the tick a stalled report recovers on', () => {
    const decoder = new SseFrameDecoder()
    expect(decoder.push(': keepalive\r\n\r\n')).toEqual([{ comment: 'keepalive' }])
  })

  it('reads a body that mixes both framings, taking whichever boundary comes first', () => {
    const decoder = new SseFrameDecoder()
    expect(decoder.push('event: a\ndata: 1\n\nevent: b\r\ndata: 2\r\n\r\n')).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' }
    ])
  })

  it('SKIPS a malformed line instead of dropping the frame around it', () => {
    const decoder = new SseFrameDecoder()
    // The daemon reads this from a backend it cannot redeploy. One unrecognized line must cost that
    // line - not the run travelling beside it, and certainly not the read loop.
    const frames = decoder.push('this-line-has-no-colon\nevent: run\ndata: 1\n\n')
    expect(frames).toEqual([{ event: 'run', data: '1' }])
  })

  it('ignores grammar fields this transport does not use, without treating them as garbage', () => {
    const decoder = new SseFrameDecoder()
    expect(decoder.push('id: 7\nretry: 5000\nevent: run\ndata: 1\n\n')).toEqual([
      { event: 'run', data: '1' }
    ])
  })

  it('yields nothing for a frame that carried no usable line at all', () => {
    const decoder = new SseFrameDecoder()
    expect(decoder.push('nonsense\n\n')).toEqual([])
  })

  it('keeps decoding after a malformed frame, so one bad frame cannot end the session', () => {
    const decoder = new SseFrameDecoder()
    decoder.push('nonsense\n\n')
    expect(decoder.push('event: run\ndata: 1\n\n')).toEqual([{ event: 'run', data: '1' }])
  })

  // The buffer is trimmed only when a blank line arrives, so a body that never contains one grows for
  // as long as the socket stays open - a backend bug or a hostile origin can walk the daemon into an
  // out-of-memory kill. It fails LOUDLY rather than truncating: a silently cut frame is a run whose
  // payload decodes to something other than what was sent.
  it('refuses to buffer past its cap when no frame boundary ever arrives', () => {
    const decoder = new SseFrameDecoder()
    const half = 'x'.repeat(MAX_BUFFERED_FRAME_CHARS / 2)
    expect(decoder.push(half)).toEqual([])
    expect(decoder.push(half)).toEqual([])
    expect(() => decoder.push('x')).toThrow(/frame/i)
  })

  it('admits a frame that fits the cap exactly, and keeps decoding after it', () => {
    const decoder = new SseFrameDecoder()
    const payload = 'y'.repeat(MAX_BUFFERED_FRAME_CHARS - 'data: \n\n'.length)
    expect(decoder.push(`data: ${payload}\n\n`)).toEqual([{ data: payload }])
    expect(decoder.push('event: run\ndata: 1\n\n')).toEqual([{ event: 'run', data: '1' }])
  })
})

describe('reconnectDelayMs', () => {
  // ATTEMPT 1 IS THE ONE THAT MATTERS. `streamLoop` puts every device that had an open stream back on
  // attempt 1, so a backend deploy - which drops every held connection in the fleet at the same instant
  // - lands the whole fleet here together. A window of exactly one value there is the lockstep return
  // this function exists to prevent, and it does not matter how well attempt 4 is spread.
  it('jitters the FIRST retry, the one a fleet-wide drop puts every device on', () => {
    const delays = Array.from({ length: 200 }, () => reconnectDelayMs(1))
    expect(new Set(delays).size).toBeGreaterThan(1)
  })

  it('spreads that first retry over a real window, not a handful of adjacent values', () => {
    const delays = Array.from({ length: 200 }, () => reconnectDelayMs(1))
    expect(Math.max(...delays) - Math.min(...delays)).toBeGreaterThan(500)
  })

  it('is NOT constant across attempts (the thundering-herd guard)', () => {
    // The property that matters, asserted the way it actually fails: a backend deploy drops every
    // device at the same instant, so a constant delay makes the whole fleet reconnect in lockstep.
    const delays = Array.from({ length: 40 }, () => reconnectDelayMs(4))
    expect(new Set(delays).size).toBeGreaterThan(1)
  })

  it('spreads a synchronized fleet across the whole window, not a wobble around one value', () => {
    const delays = Array.from({ length: 200 }, () => reconnectDelayMs(5))
    const min = Math.min(...delays)
    const max = Math.max(...delays)
    // Full jitter, not a small margin: the spread has to be a large fraction of the window or a
    // thousand devices still arrive in a clump.
    expect(max - min).toBeGreaterThan(4_000)
  })

  it('backs off exponentially as attempts mount', () => {
    // Pinned with the top of the window (random -> 1) so this asserts the schedule, not a sample. The
    // first window is already twice the floor, which is what leaves attempt 1 something to jitter over.
    const top = (attempt: number) => reconnectDelayMs(attempt, () => 1)
    expect(top(1)).toBe(2_000)
    expect(top(2)).toBe(4_000)
    expect(top(3)).toBe(8_000)
    expect(top(4)).toBe(16_000)
  })

  it('never drops below the floor, so a fast-failing backend is not hammered', () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(reconnectDelayMs(attempt, () => 0)).toBeGreaterThanOrEqual(1_000)
    }
  })

  it('caps the window so a long outage still retries every half minute', () => {
    expect(reconnectDelayMs(50, () => 1)).toBe(30_000)
    expect(reconnectDelayMs(50, () => 0)).toBe(1_000)
  })
})
