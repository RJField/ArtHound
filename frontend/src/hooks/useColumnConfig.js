import { useState, useEffect } from 'react'

const PREFIX = 'arthound:assetColumns'
// Name column is always pinned visible.
const PINNED = 'slot:name'
export const DEFAULT_VISIBLE = ['slot:name', 'slot:item_type', 'slot:priority']

function readKey(studioId) {
  return studioId ? `${PREFIX}:${studioId}` : `${PREFIX}:default`
}

export function useColumnConfig(studioId) {
  const [visibleIds, setVisibleIds] = useState(DEFAULT_VISIBLE)

  // Re-read localStorage whenever studioId becomes known (profile async load).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(readKey(studioId))
      if (raw) {
        const parsed = JSON.parse(raw)?.visible
        if (Array.isArray(parsed) && parsed.length) {
          setVisibleIds(parsed)
          return
        }
      }
    } catch {}
    setVisibleIds(DEFAULT_VISIBLE)
  }, [studioId])

  function toggleColumn(id) {
    if (id === PINNED) return
    setVisibleIds(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      try {
        localStorage.setItem(readKey(studioId), JSON.stringify({ visible: next }))
      } catch {}
      return next
    })
  }

  // Guarantee name is always present even if localStorage entry is stale.
  const effective = visibleIds.includes(PINNED) ? visibleIds : [PINNED, ...visibleIds]

  return { visibleColumnIds: effective, toggleColumn }
}
