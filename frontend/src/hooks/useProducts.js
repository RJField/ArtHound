import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { useAppState } from '../contexts/AppContext'

export function useProducts() {
  const { state, update } = useAppState()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (state.products.length) return
    setLoading(true)
    apiFetch('/api/assets/products')
      .then(data => update({ products: data }))
      .catch(err => toast.error(err.message))
      .finally(() => setLoading(false))
  }, [])

  return { products: state.products, loading }
}
