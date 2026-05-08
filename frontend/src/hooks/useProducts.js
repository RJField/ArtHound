import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { useAppState } from '../contexts/AppContext'

export function useProducts() {
  const { state, update } = useAppState()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (state.products.length) return
    const controller = new AbortController()
    setLoading(true)
    apiFetch('/api/assets/products', { signal: controller.signal })
      .then(data => update({ products: data }))
      .catch(err => { if (err.name !== 'AbortError') toast.error(err.message) })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [])

  return { products: state.products, loading }
}
