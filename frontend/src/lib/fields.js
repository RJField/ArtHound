export const LINKED_TABLE_MAP = {
  'Asset':  'assets',
  'Assets': 'assets',
}

export function fmtDate(iso) {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${m}/${d}/${y}`
}

// Extracts a plain display string from any canonical or raw field value.
export function fieldDisplayString(v) {
  if (v == null) return ''
  if (Array.isArray(v)) {
    if (!v.length) return ''
    const first = v[0]
    if (typeof first === 'object' && first !== null) {
      if ('source_id' in first) {
        return v.map(x => x.display_name || x.source_id || '').filter(Boolean).join(', ')
      }
      if ('url' in first) return v.map(x => x.filename || x.url).join(', ')
    }
    return v.join(', ')
  }
  if (typeof v === 'object' && v !== null) {
    return v.display_name || v.label || v.name || v.email || ''
  }
  return String(v)
}

/**
 * Converts a raw field value dict into a FieldDef array for DetailModal/FieldGrid.
 *
 * proxyUrlFn(fieldKey, idx) — optional; called for each attachment item to build
 * the backend proxy URL. When omitted, items are emitted without a proxyUrl (e.g.
 * for display-only contexts where viewing isn't needed).
 */
export function formatRawFields(rawFields, proxyUrlFn = null) {
  return Object.entries(rawFields)
    .filter(([, v]) => v != null && v !== '')
    .flatMap(([k, v]) => {
      if (Array.isArray(v)) {
        if (!v.length) return []
        const first = v[0]
        if (typeof first === 'object' && first !== null) {
          if ('url' in first) {
            // Attachment list — group into a single 'attachments' entry
            return [{
              label: k,
              type: 'attachments',
              items: v.map((att, i) => ({
                filename: att.filename || att.url || 'attachment',
                mimetype: att.mimetype || null,
                size_bytes: att.size_bytes || null,
                proxyUrl: proxyUrlFn ? proxyUrlFn(k, i) : null,
              })),
            }]
          }
          if ('source_id' in first) {
            const display = v.map(x => x.display_name || x.source_id || '').filter(Boolean).join(', ')
            return display ? [{ label: k, value: display }] : []
          }
        }
        return [{ label: k, value: v.join(', ') }]
      }
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        return [{ label: k, value: fmtDate(v.slice(0, 10)) }]
      }
      if (typeof v === 'object' && v !== null) {
        const display = v.display_name || v.label || v.name || v.email || ''
        return display ? [{ label: k, value: display }] : []
      }
      return [{ label: k, value: String(v) }]
    })
}
