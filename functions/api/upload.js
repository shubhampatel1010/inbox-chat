import { requireAuth, requireConversationAccess } from '../_lib/auth.js'
import { uploadObject, ALLOWED_MIME, MAX_UPLOAD_BYTES } from '../_lib/storage.js'
import { json, badRequest, serverError } from '../_lib/respond.js'

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  let form
  try {
    form = await request.formData()
  } catch {
    return badRequest('Expected multipart/form-data')
  }

  const conversationId = Number(form.get('conversation_id'))
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return badRequest('conversation_id is required')
  }

  const file = form.get('file')
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    return badRequest('A file is required')
  }

  // Same role rule as sending: an agent can only touch their own conversations,
  // which also stops them writing into another conversation's storage folder.
  const access = await requireConversationAccess(env, auth.user, conversationId)
  if (access.response) return access.response

  const mime = String(file.type || '').toLowerCase().split(';')[0].trim()
  const allowed = ALLOWED_MIME[mime]
  if (!allowed) {
    return badRequest(`Files of type "${mime || 'unknown'}" are not allowed`)
  }

  const size = Number(file.size) || 0
  if (size > MAX_UPLOAD_BYTES) {
    return badRequest('File is larger than the 16MB limit')
  }
  if (size === 0) {
    return badRequest('File is empty')
  }

  try {
    const bytes = await file.arrayBuffer()
    // Trust the measured length over the declared size.
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return badRequest('File is larger than the 16MB limit')
    }

    const filename = typeof file.name === 'string' ? file.name : ''

    const result = await uploadObject(env, {
      conversationId,
      bytes,
      mime,
      filename,
    })

    if (!result.ok) {
      // Surfaced as a normal error response so the composer can show it inline.
      return json({ ok: false, error: 'Upload failed. Please try again.' }, 502)
    }

    return json({
      ok: true,
      media_path: result.path,
      media_type: allowed.type,
      media_mime: mime,
      media_filename: filename.slice(0, 255) || null,
      media_size: bytes.byteLength,
    })
  } catch (err) {
    return serverError(err.message || 'Upload failed')
  }
}
