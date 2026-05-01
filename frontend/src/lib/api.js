import { getSupabase } from './supabase'
import { formatRawFields } from './fields'

export async function apiFetch(path, opts = {}) {
  const sb = await getSupabase()
  const { data: { session } } = await sb.auth.getSession()
  const token = session?.access_token

  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? res.statusText)
  }

  return res.json()
}

// Builds a resolve() fn for DetailModal linked-record fields.
export function makeRecordResolver(tableKey, recordId, fallbackTitle) {
  return async () => {
    const { fields } = await apiFetch(`/api/records/${tableKey}/${encodeURIComponent(recordId)}`)
    const title = fields.Name || fields.name
      || Object.values(fields).find(v => typeof v === 'string' && v.length > 0)
      || fallbackTitle
    return { title, fields: formatRawFields(fields) }
  }
}
