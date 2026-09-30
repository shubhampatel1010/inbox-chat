import { createClient } from '@supabase/supabase-js'

// Supabase over HTTPS/fetch. Raw Postgres sockets hang on the Workers runtime,
// so all data access goes through PostgREST instead.
//
// One client per isolate. Pages Functions re-use the module scope across
// requests on a warm isolate, so we memoize instead of rebuilding per call.
let client = null
let cachedUrl = null

/**
 * The service key has been provisioned under both names across environments,
 * so accept either rather than failing on a naming mismatch.
 */
export function serviceKey(env) {
  return env?.SUPABASE_SERVICE_ROLE_KEY || env?.SUPABASE_SERVICE_KEY || null
}

export function getDb(env) {
  const key = serviceKey(env)
  if (!env?.SUPABASE_URL || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured')
  }
  if (client && cachedUrl === env.SUPABASE_URL) return client

  cachedUrl = env.SUPABASE_URL
  // Service role key — bypasses RLS, so this must stay server-side only.
  client = createClient(env.SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return client
}

/** Postgres unique-violation, surfaced by PostgREST as a code on the error. */
export const UNIQUE_VIOLATION = '23505'

/**
 * Throws on a Supabase error, otherwise returns the data.
 * Keeps endpoints from repeating the `if (error) throw` dance.
 */
export function unwrap({ data, error }) {
  if (error) {
    const err = new Error(error.message || 'Database error')
    err.code = error.code
    err.details = error.details
    throw err
  }
  return data
}

/**
 * Case-insensitive email lookup.
 *
 * PostgREST has no `lower(col) = lower($1)`, and `ilike` treats `%` and `_` as
 * wildcards, so a crafted address could match a row it shouldn't. We escape the
 * pattern AND re-check equality in JS, which is the authoritative comparison —
 * any wildcard that slipped through cannot produce a false match.
 */
export async function findUserByEmail(env, email, columns = '*') {
  const normalized = String(email || '').trim().toLowerCase()
  if (!normalized) return null

  const pattern = normalized.replace(/([\\%_])/g, '\\$1')

  const rows = unwrap(
    await getDb(env).from('wp_chat_users').select(columns).ilike('email', pattern).limit(10)
  )

  return rows?.find((row) => String(row.email || '').toLowerCase() === normalized) ?? null
}
