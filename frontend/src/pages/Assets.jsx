import { useState } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { useAppState } from '../contexts/AppContext'
import { useAuth } from '../contexts/AuthContext'
import { useProducts } from '../hooks/useProducts'
import { useAssets } from '../hooks/useAssets'
import { useViewSchema } from '../hooks/useViewSchema'
import { useColumnConfig } from '../hooks/useColumnConfig'
import ProductSidebar  from '../components/assets/ProductSidebar'
import AssetGrid       from '../components/assets/AssetGrid'
import AssetDetailPanel from '../components/assets/AssetDetailPanel'
import SendVendorModal from '../components/SendVendorModal'
import SchemaModal     from '../components/SchemaModal'

export default function Assets() {
  const { state, update }                            = useAppState()
  const { profile }                                  = useAuth()
  const { products, loading: productsLoading }       = useProducts()
  const { assets,   loading: assetsLoading }         = useAssets(state.selectedProductId)
  const schema                                       = useViewSchema()
  const { visibleColumnIds, toggleColumn }           = useColumnConfig(profile?.org?.id)

  const [genBusy,        setGenBusy]        = useState(false)
  const [genResult,      setGenResult]      = useState(null)
  const [taskRefreshKey, setTaskRefreshKey] = useState(0)
  const [modal,          setModal]          = useState(null) // 'send' | 'schema'

  const focusedAsset   = assets.find(a => a.id === state.focusedAssetId) ?? null
  const selectedAssets = assets.filter(a => state.selectedAssetIds.has(a.id))

  const productName = state.selectedProductId === '__none__'
    ? 'No product'
    : (products.find(p => p.id === state.selectedProductId)?.name ?? '')

  function selectProduct(id) {
    update({ selectedProductId: id, focusedAssetId: null, selectedAssetIds: new Set() })
    setGenResult(null)
  }

  function toggleAsset(id, checked) {
    const next = new Set(state.selectedAssetIds)
    checked ? next.add(id) : next.delete(id)
    update({ selectedAssetIds: next })
    setGenResult(null)
  }

  function toggleAll(checked) {
    update({ selectedAssetIds: checked ? new Set(assets.map(a => a.id)) : new Set() })
    setGenResult(null)
  }

  async function generate() {
    const assetIds = [...state.selectedAssetIds]
    if (!assetIds.length) return
    setGenBusy(true)
    setGenResult(null)
    try {
      const result = await apiFetch('/api/schedule/generate-bulk', {
        method: 'POST',
        body: JSON.stringify({ assetIds }),
      })
      setGenResult(result)
      if (result.created > 0) {
        toast.success(`${result.created} task${result.created !== 1 ? 's' : ''} created`)
        setTaskRefreshKey(k => k + 1)
      } else if (result.failed?.length) {
        toast.error('Generation failed — see details below')
      }
    } catch (err) {
      toast.error(err.message)
    } finally {
      setGenBusy(false)
    }
  }

  return (
    <main className="flex flex-1 overflow-hidden">
      <ProductSidebar
        products={products}
        loading={productsLoading}
        selectedId={state.selectedProductId}
        onSelect={selectProduct}
        onSchemaClick={() => setModal('schema')}
      />
      <AssetGrid
        assets={assets}
        loading={assetsLoading}
        selectedProductId={state.selectedProductId}
        productName={productName}
        selectedIds={state.selectedAssetIds}
        focusedId={state.focusedAssetId}
        schema={schema}
        visibleColumnIds={visibleColumnIds}
        onToggleColumn={toggleColumn}
        onToggleAsset={toggleAsset}
        onToggleAll={toggleAll}
        onFocusAsset={id => update({ focusedAssetId: id })}
        genBusy={genBusy}
        genResult={genResult}
        onGenerate={generate}
        onSend={() => setModal('send')}
      />
      <AssetDetailPanel
        asset={focusedAsset}
        schema={schema}
        taskRefreshKey={taskRefreshKey}
      />

      {modal === 'send' && (
        <SendVendorModal
          selectedAssets={selectedAssets}
          onClose={() => setModal(null)}
          onSent={() => setModal(null)}
        />
      )}
      {modal === 'schema' && <SchemaModal onClose={() => setModal(null)} />}
    </main>
  )
}
