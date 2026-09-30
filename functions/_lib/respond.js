const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...BASE_HEADERS, ...headers },
  })
}

export const ok = (data = {}) => json({ ok: true, ...data }, 200)

export const badRequest = (error = 'Bad request') => json({ ok: false, error }, 400)
export const unauthorized = (error = 'Unauthorized') => json({ ok: false, error }, 401)
export const forbidden = (error = 'Forbidden') => json({ ok: false, error }, 403)
export const notFound = (error = 'Not found') => json({ ok: false, error }, 404)
export const serverError = (error = 'Internal server error') =>
  json({ ok: false, error }, 500)

/** Parse a JSON body, returning {} rather than throwing on malformed input. */
export async function readJson(request) {
  try {
    const body = await request.json()
    return body && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
}
