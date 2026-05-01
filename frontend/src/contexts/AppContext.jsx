import { createContext, useContext, useState } from 'react'

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
  const [state, setState] = useState(initial)

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
