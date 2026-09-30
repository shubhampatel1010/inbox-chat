// Vercel adapter for the Cloudflare Pages Functions in functions/api/.
//
// Vercel does not run the functions/ directory, so every /api/* request is
// rewritten here (see vercel.json) and dispatched to the same handler module
// Cloudflare would have used, with the same context shape:
// { request, env, params, waitUntil }.
//
// The route table below mirrors functions/api/ — when you add or remove a
// file there, add or remove its line here too.

import { waitUntil } from '@vercel/functions'

import * as m0 from "../functions/api/accounts.js"
import * as m1 from "../functions/api/accounts/settings.js"
import * as m2 from "../functions/api/accounts/users.js"
import * as m3 from "../functions/api/assign.js"
import * as m4 from "../functions/api/attention/events.js"
import * as m5 from "../functions/api/channel/clear-halt.js"
import * as m6 from "../functions/api/channel/qr.js"
import * as m7 from "../functions/api/channel/relaunch.js"
import * as m8 from "../functions/api/channel/status.js"
import * as m9 from "../functions/api/conversation/ask.js"
import * as m10 from "../functions/api/conversation/dismiss-attention.js"
import * as m11 from "../functions/api/conversation/media.js"
import * as m12 from "../functions/api/conversation/restore-attention.js"
import * as m13 from "../functions/api/conversation/summary.js"
import * as m14 from "../functions/api/conversations.js"
import * as m15 from "../functions/api/conversations/new.js"
import * as m16 from "../functions/api/groups/members.js"
import * as m17 from "../functions/api/leads/mine.js"
import * as m18 from "../functions/api/leads/outcome.js"
import * as m19 from "../functions/api/login.js"
import * as m20 from "../functions/api/logout.js"
import * as m21 from "../functions/api/media/[[path]].js"
import * as m22 from "../functions/api/messages.js"
import * as m23 from "../functions/api/messages/forward.js"
import * as m24 from "../functions/api/password/change.js"
import * as m25 from "../functions/api/password/reset.js"
import * as m26 from "../functions/api/portal/ask.js"
import * as m27 from "../functions/api/push/key.js"
import * as m28 from "../functions/api/push/subscribe.js"
import * as m29 from "../functions/api/push/token.js"
import * as m30 from "../functions/api/push/unsubscribe.js"
import * as m31 from "../functions/api/refresh.js"
import * as m32 from "../functions/api/search.js"
import * as m33 from "../functions/api/send.js"
import * as m34 from "../functions/api/summaries/batch.js"
import * as m35 from "../functions/api/sync/start.js"
import * as m36 from "../functions/api/sync/status.js"
import * as m37 from "../functions/api/sync/step.js"
import * as m38 from "../functions/api/upload.js"
import * as m39 from "../functions/api/users.js"
import * as m40 from "../functions/api/users/create.js"
import * as m41 from "../functions/api/users/department.js"
import * as m42 from "../functions/api/video-call.js"
import * as m43 from "../functions/api/whapi/webhook/[secret].js"

const ROUTES = [
  ["accounts", m0],
  ["accounts/settings", m1],
  ["accounts/users", m2],
  ["assign", m3],
  ["attention/events", m4],
  ["channel/clear-halt", m5],
  ["channel/qr", m6],
  ["channel/relaunch", m7],
  ["channel/status", m8],
  ["conversation/ask", m9],
  ["conversation/dismiss-attention", m10],
  ["conversation/media", m11],
  ["conversation/restore-attention", m12],
  ["conversation/summary", m13],
  ["conversations", m14],
  ["conversations/new", m15],
  ["groups/members", m16],
  ["leads/mine", m17],
  ["leads/outcome", m18],
  ["login", m19],
  ["logout", m20],
  ["media/[[path]]", m21],
  ["messages", m22],
  ["messages/forward", m23],
  ["password/change", m24],
  ["password/reset", m25],
  ["portal/ask", m26],
  ["push/key", m27],
  ["push/subscribe", m28],
  ["push/token", m29],
  ["push/unsubscribe", m30],
  ["refresh", m31],
  ["search", m32],
  ["send", m33],
  ["summaries/batch", m34],
  ["sync/start", m35],
  ["sync/status", m36],
  ["sync/step", m37],
  ["upload", m38],
  ["users", m39],
  ["users/create", m40],
  ["users/department", m41],
  ["video-call", m42],
  ["whapi/webhook/[secret]", m43],
]

// Turns a Pages file path into a matcher. "[name]" is one segment,
// "[[name]]" is a catch-all that yields an array.
function compile(route) {
  const parts = route.split('/')
  return (segments) => {
    const params = {}
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const catchAll = part.match(/^\[\[(.+)\]\]$/)
      if (catchAll) {
        params[catchAll[1]] = segments.slice(i)
        return params
      }
      if (i >= segments.length) return null
      const single = part.match(/^\[(.+)\]$/)
      if (single) params[single[1]] = segments[i]
      else if (part !== segments[i]) return null
    }
    return segments.length === parts.length ? params : null
  }
}

// Static routes first so a literal path never loses to a dynamic sibling.
const TABLE = ROUTES.map(([route, mod]) => ({
  mod,
  match: compile(route),
  dynamic: route.includes('['),
})).sort((a, b) => a.dynamic - b.dynamic)

function notFound() {
  return Response.json({ ok: false, error: 'Not found' }, { status: 404 })
}

async function handle(request) {
  const url = new URL(request.url)

  // The rewrite passes the original path in __route. Fall back to the URL
  // path in case the platform already hands us the original URL.
  let route = url.searchParams.get('__route')
  url.searchParams.delete('__route')
  if (route == null) route = url.pathname.replace(/^\/api\/?/, '')
  url.pathname = '/api/' + route

  const segments = route.split('/').filter(Boolean).map(decodeURIComponent)

  for (const { mod, match } of TABLE) {
    const params = match(segments)
    if (!params) continue

    const method = request.method.charAt(0) + request.method.slice(1).toLowerCase()
    const fn = mod['onRequest' + method] || mod.onRequest
    if (!fn) return Response.json({ ok: false, error: 'Method not allowed' }, { status: 405 })

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    const req = new Request(url, {
      method: request.method,
      headers: request.headers,
      body: hasBody ? request.body : undefined,
      duplex: 'half',
    })

    return fn({
      request: req,
      env: { ...process.env },
      params,
      waitUntil,
      data: {},
      next: notFound,
    })
  }

  return notFound()
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const OPTIONS = handle
export const HEAD = handle
