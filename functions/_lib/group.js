import { getDb, unwrap } from './db.js'
import { fetchGroupInfo, fetchGroupIcon } from './whapi.js'
import { uploadObject } from './storage.js'

const MAX_ICON_BYTES = 2 * 1024 * 1024

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * Pull a group's subject, members and picture from Whapi into our tables.
 *
 * Every stage is independent: a failure in one leaves the others' data in
 * place, and the conversation stays usable with whatever arrived. Never
 * throws — the caller hands this to waitUntil.
 */
export async function syncGroup(env, conversationId, groupJid) {
  const db = getDb(env)
  const result = { subject: false, members: 0, icon: false, errors: [] }

  // --- subject + members ---
  const info = await fetchGroupInfo(env, groupJid)
  if (!info.ok) {
    result.errors.push(info.error)
    console.error('group sync: info fetch failed', JSON.stringify({ conversationId, error: info.error }))
  } else {
    const patch = { updated_at: new Date().toISOString() }

    // Only fill a blank subject — a human may have renamed the conversation.
    if (info.subject) {
      const current = unwrap(
        await db
          .from('wp_chat_conversations')
          .select('customer_name')
          .eq('id', conversationId)
          .maybeSingle()
      )
      if (!String(current?.customer_name || '').trim()) {
        patch.customer_name = info.subject
        result.subject = true
      }
    }

    if (info.participants.length) {
      try {
        await replaceMembers(db, conversationId, info.participants)
        patch.member_count = info.participants.length
        result.members = info.participants.length
      } catch (err) {
        result.errors.push(String(err?.message || 'members_write_failed'))
        console.error('group sync: member write failed', JSON.stringify({ conversationId, error: String(err?.message) }))
      }
    }

    try {
      unwrap(await db.from('wp_chat_conversations').update(patch).eq('id', conversationId))
    } catch (err) {
      result.errors.push(String(err?.message || 'conversation_update_failed'))
    }
  }

  // --- picture, through the same storage pipeline contact avatars use ---
  const icon = await fetchGroupIcon(env, groupJid, MAX_ICON_BYTES)
  if (!icon.ok) {
    // A group with no picture is normal — initials from the subject render
    // instead — so this is not an error state worth flagging to the user.
    console.log('group sync: no icon', JSON.stringify({ conversationId, reason: icon.error }))
    try {
      unwrap(
        await db.from('wp_chat_conversations').update({ avatar_error: false }).eq('id', conversationId)
      )
    } catch {
      /* advisory only */
    }
  } else {
    const mime = EXT_BY_MIME[icon.mime] ? icon.mime : 'image/jpeg'
    const uploaded = await uploadObject(env, {
      conversationId,
      bytes: icon.bytes,
      mime,
      // Same {conversation_id}/… prefix, so the existing signed-URL route
      // authorises group icons with no change.
      filename: `avatar-${crypto.randomUUID()}.${EXT_BY_MIME[mime] || 'jpg'}`,
    })
    if (uploaded.ok) {
      try {
        unwrap(
          await db
            .from('wp_chat_conversations')
            .update({ avatar_path: uploaded.path, avatar_error: false })
            .eq('id', conversationId)
        )
        result.icon = true
      } catch (err) {
        result.errors.push(String(err?.message || 'icon_write_failed'))
      }
    } else {
      result.errors.push(uploaded.error)
      console.error('group sync: icon upload failed', JSON.stringify({ conversationId, error: uploaded.error }))
    }
  }

  console.log('group sync:', JSON.stringify({ conversationId, ...result }))
  return result
}

/**
 * Replace the membership snapshot.
 *
 * Delete-then-insert rather than upsert: a member who LEFT must disappear, and
 * PostgREST has no primitive for "delete everything not in this set".
 */
async function replaceMembers(db, conversationId, participants) {
  const syncedAt = new Date().toISOString()

  unwrap(await db.from('wp_chat_group_members').delete().eq('conversation_id', conversationId))

  // Dedupe defensively — a duplicated participant would trip the UNIQUE index
  // and lose the whole snapshot.
  const seen = new Set()
  const rows = []
  for (const p of participants) {
    if (!p.number || seen.has(p.number)) continue
    seen.add(p.number)
    rows.push({
      conversation_id: conversationId,
      member_number: p.number,
      member_name: p.name,
      is_admin: Boolean(p.isAdmin),
      synced_at: syncedAt,
    })
  }
  if (rows.length) unwrap(await db.from('wp_chat_group_members').insert(rows))
  return rows.length
}
