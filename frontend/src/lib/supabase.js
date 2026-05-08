import { createClient } from '@supabase/supabase-js'

let _promise = null

export function getSupabase() {
  if (_promise) return _promise
  _promise = fetch('/api/config')
    .then(async res => {
      if (!res.ok) throw new Error('Failed to load app config')
      const { supabaseUrl, supabaseAnonKey } = await res.json()
      return createClient(supabaseUrl, supabaseAnonKey)
    })
    .catch(err => {
      _promise = null // allow retry on failure
      throw err
    })
  return _promise
}
