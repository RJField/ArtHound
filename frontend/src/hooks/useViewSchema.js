import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'

// Module-level singleton: schema is stable for the session and only changes
// when the studio remaps fields (which requires a page reload via re-init).
let _promise = null
let _cached  = null

export function useViewSchema() {
  const [schema, setSchema] = useState(_cached)

  useEffect(() => {
    if (_cached) return
    if (!_promise) {
      _promise = apiFetch('/api/assets/view-schema')
        .then(data => { _cached = data; return data })
        .catch(err => { _promise = null; throw err })
    }
    _promise.then(setSchema).catch(console.warn)
  }, [])

  return schema
}
