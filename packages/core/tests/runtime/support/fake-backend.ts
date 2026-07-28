import type { HttpClient, HttpResponse } from '../../../src/runtime/poll-client'

/**
 * The recording HTTP fake the runtime's backend suites drive. A byte-identical twin lives at
 * `apps/companion/tests/support/fake-backend.ts` for the shell's own `serve` suite: a package
 * boundary sits between them and the companion export pipeline copies each package independently,
 * so a shared file would have to be reached by a relative path that the exported layout breaks.
 * Keep the two in step when either changes.
 */

/**
 * One request a {@link createRecordingHttp} client captured. `headers` is optional so a suite that asserts
 * over the serialized `calls` (and never inspects headers) can record a header-free shape via
 * {@link RecordingHttpOptions.recordHeaders}.
 */
export interface RecordedRequest {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
}

/**
 * Scripts the response for one recorded request. The per-suite endpoint routing (which path returns what)
 * lives in this callback; only the capture-and-delegate boilerplate is shared. The `calls` recorded so far
 * are passed too, for a route that keys off request order.
 */
export type FakeRoute = (
  recorded: RecordedRequest,
  calls: readonly RecordedRequest[]
) => HttpResponse | Promise<HttpResponse>

/** Options for {@link createRecordingHttp}. */
export interface RecordingHttpOptions {
  /**
   * Whether to capture each request's headers on the recorded call (default true). Suites that assert over the
   * serialized `calls` and never inspect headers opt out so the recorded shape stays header-free.
   */
  recordHeaders?: boolean
}

/**
 * A recording fake {@link HttpClient}: captures every request into `calls` and delegates the response to
 * `route`. Replaces the identical capture-and-delegate boilerplate the transport suites each hand-rolled;
 * each suite keeps its own `route` (the endpoint scripting that genuinely differs between them).
 *
 * @param route - Maps a recorded request to its scripted {@link HttpResponse}.
 * @param options - Recording options; see {@link RecordingHttpOptions}.
 * @returns The fake client plus the live array of requests it has recorded.
 */
export function createRecordingHttp(
  route: FakeRoute,
  options: RecordingHttpOptions = {}
): { http: HttpClient; calls: RecordedRequest[] } {
  const recordHeaders = options.recordHeaders ?? true
  const calls: RecordedRequest[] = []
  const http: HttpClient = async (url, init) => {
    const recorded: RecordedRequest = {
      url,
      method: init.method,
      ...(recordHeaders ? { headers: init.headers } : {}),
      ...(init.body ? { body: init.body } : {})
    }
    calls.push(recorded)
    return route(recorded, calls)
  }
  return { http, calls }
}
