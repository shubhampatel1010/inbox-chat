import { useState } from 'react'
import { UserCheck } from 'lucide-react'
import { api } from '../lib/api.js'
import { avatarIndex } from '../lib/format.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useToast } from '../context/ToastContext.jsx'

export default function AssignControl({ conversation, users, onAssigned }) {
  const { isAdmin } = useAuth()
  const toast = useToast()
  const [saving, setSaving] = useState(false)

  // Agents see who owns the conversation but cannot change it — the server
  // enforces this too; this is only to keep the UI honest.
  if (!isAdmin) {
    return (
      <span
        className="assign-static"
        // Matches the conversation list, so one agent is one colour throughout.
        data-agent={
          conversation.assigned_to && conversation.assigned_user_id != null
            ? avatarIndex(conversation.assigned_user_id)
            : undefined
        }
      >
        <UserCheck size={13} />
        {conversation.assigned_to || 'Unassigned'}
      </span>
    )
  }

  const change = async (raw) => {
    const assignedUserId = raw === '' ? null : Number(raw)
    setSaving(true)
    try {
      const data = await api.assign(conversation.id, assignedUserId)
      onAssigned(data.conversation)
      toast.success(
        'Conversation assigned',
        assignedUserId ? `Now handled by ${data.conversation.assigned_to}` : 'Unassigned'
      )
    } catch (err) {
      toast.error('Could not assign', err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="assign">
      <select
        className="select"
        aria-label="Assign conversation to"
        disabled={saving}
        value={conversation.assigned_user_id ?? ''}
        onChange={(e) => change(e.target.value)}
      >
        <option value="">Unassigned</option>
        {users
          .filter((u) => u.is_active)
          .map((user) => (
            <option key={user.id} value={user.id}>
              {user.name}
            </option>
          ))}
      </select>
    </div>
  )
}
