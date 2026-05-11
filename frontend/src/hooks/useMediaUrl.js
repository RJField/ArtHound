import { useState, useEffect } from 'react'
import { apiFetchRaw } from '../lib/api'

/**
 * Fetches a JWT-protected proxy URL and returns a local blob URL safe to use
 * in <img src>, <video src>, canvas, etc. Cleans up the blob URL on unmount.
 *
 * Handles the 202 case (attachment copy still in progress) as `pending: true`
 * so callers can show an appropriate "check back later" message instead of
 * a generic error.
 *
 * Returns { blobUrl, loading, error, pending }
 */
export function useMediaUrl(proxyUrl) {
  const [blobUrl,  setBlobUrl]  = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [pending,  setPending]  = useState(false)

  useEffect(() => {
    if (!proxyUrl) { setBlobUrl(null); setPending(false); return }

    let objectUrl = null
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setPending(false)
    setBlobUrl(null)

    apiFetchRaw(proxyUrl, { signal: controller.signal })
      .then(r => {
        if (r.status === 202) { setPending(true); setLoading(false); return null }
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
        return r.blob()
      })
      .then(blob => {
        if (!blob) return
        objectUrl = URL.createObjectURL(blob)
        setBlobUrl(objectUrl)
        setLoading(false)
      })
      .catch(err => {
        if (err.name !== 'AbortError') { setError(err.message); setLoading(false) }
      })

    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [proxyUrl])

  return { blobUrl, loading, error, pending }
}
