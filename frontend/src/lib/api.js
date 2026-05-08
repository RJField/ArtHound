import { getSupabase } from './supabase'
import { formatRawFields } from './fields'

// Kept current by AuthContext via onAuthStateChange — avoids per-request getSession() calls.
let _accessToken = null

export function setAccessToken(token) {
  _accessToken = token
}

async function _getToken() {
  if (_accessToken) return _accessToken
  // Cold-start fallback: AuthContext hasn't pushed a token yet.
  const sb = await getSupabase()
  const { data: { session } } = await sb.auth.getSession()
  return session?.access_token ?? null
}

export async function apiFetch(path, opts = {}) {
  const token = await _getToken()

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
    throw new Error(body.detail ?? body.error ?? res.statusText)
  }

  if (res.status === 204 || res.headers.get('content-length') === '0') return null
  return res.json()
}

// Raw fetch with JWT — returns the Response object for blob/stream consumption.
export async function apiFetchRaw(path, opts = {}) {
  const token = await _getToken()
  return fetch(path, {
    ...opts,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  })
}

// Returns the JWT access token (needed for pdf.js httpHeaders).
export async function getAuthToken() {
  return _getToken()
}

// Proxy URL for a live attachment on a replicated asset (studio Asset Viewer only).
export function assetAttachmentUrl(canonicalAssetId, fieldKey, idx) {
  return `/api/attachments/asset/${canonicalAssetId}/${encodeURIComponent(fieldKey)}/${idx}`
}

// Proxy URL for a frozen attachment copy stored in Supabase Storage (vendor inbox / reviews).
export function payloadAttachmentUrl(dispatchId, canonicalAssetId, fieldKey, idx) {
  return `/api/attachments/payload/${dispatchId}/${canonicalAssetId}/${encodeURIComponent(fieldKey)}/${idx}`
}

// Multipart upload with JWT — no Content-Type header (browser sets boundary).
export async function apiUpload(path, formData) {
  const token = await _getToken()
  const res = await fetch(path, {
    method: 'POST',
    body: formData,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail ?? body.error ?? res.statusText)
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return null
  return res.json()
}

// Proxy URL for a review attachment stored in Supabase Storage.
export function reviewAttachmentUrl(reviewId, attachmentId) {
  return `/api/reviews/${reviewId}/attachments/${attachmentId}/content`
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
