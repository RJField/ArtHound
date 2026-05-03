import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'

export const NO_PRODUCT_ID = '__none__'

export function useAssets(productId) {
  const [assets, setAssets]   = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!productId) {
      setAssets([])
      return
    }
    setAssets([])   // clear immediately — zero stale data between product switches
    setLoading(true)
    const url = productId === NO_PRODUCT_ID
      ? '/api/assets?unassigned=true'
      : `/api/assets?productId=${encodeURIComponent(productId)}`
    apiFetch(url)
      .then(setAssets)
      .catch(() => setAssets([]))
      .finally(() => setLoading(false))
  }, [productId])

  return { assets, loading }
}
