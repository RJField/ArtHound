import { createClient } from '@supabase/supabase-js'

let client = null

export async function getSupabase() {
  if (client) return client
  const res = await fetch('/api/config')
  if (!res.ok) throw new Error('Failed to load app config')
  const { supabaseUrl, supabaseAnonKey } = await res.json()
  client = createClient(supabaseUrl, supabaseAnonKey)
  return client
}
