import { createContext, useContext, useState, useEffect } from 'react'
import { useAuth } from './AuthContext'

const AppContext = createContext(null)

const initial = {
  products:          [],
  selectedProductId: null,
  assets:            [],
  selectedAssetIds:  new Set(),
  focusedAssetId:    null,
  focusedAsset:      null,
  taskView:          'list',      // 'list' | 'timeline'
  taskSource:        'airtable',  // 'airtable' | 'arthound'
  lastTasks:         null,
}

export function AppProvider({ children }) {
  const { session } = useAuth()
  const [state, setState] = useState(initial)

  // Reset all app state when the logged-in user changes
  useEffect(() => {
    setState(initial)
  }, [session?.user?.id])

  function update(patch) {
    setState(prev => ({ ...prev, ...patch }))
  }

  return (
    <AppContext.Provider value={{ state, update }}>
      {children}
    </AppContext.Provider>
  )
}

export function useAppState() {
  return useContext(AppContext)
}
