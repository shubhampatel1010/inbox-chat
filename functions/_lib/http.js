/**
 * Release a fetch() response body we are NOT going to read.
 *
 * On the Cloudflare Workers runtime, a response whose body is never consumed
 * keeps its underlying connection open. The runtime eventually logs
 *   "A stalled HTTP response was canceled to prevent deadlock ...
 *    the Worker did not read the responses."
 * and, under load — a year-long sync makes thousands of media fetches — the
 * leaked connections can exhaust the concurrent-request limit mid-run.
 *
 * Call this on every status-only check and early-return path that does not
 * otherwise read the body (.text/.json/.arrayBuffer). Reading the body already
 * drains it, so those paths need nothing.
 *
 * Safe to call unconditionally: no-op when there is no body, and swallows the
 * "already read/locked" error if the body was consumed elsewhere.
 */
export async function drainBody(res) {
  try {
    await res?.body?.cancel()
  } catch {
    /* already consumed, locked, or no body to cancel */
  }
}
