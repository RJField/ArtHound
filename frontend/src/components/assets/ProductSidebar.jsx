import { cn } from '../../lib/utils'
import { NO_PRODUCT_ID } from '../../hooks/useAssets'

export default function ProductSidebar({ products, loading, selectedId, onSelect, onSchemaClick }) {
  return (
    <div className="w-44 border-r border-border flex flex-col shrink-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-muted text-xs font-medium">Products</span>
        <button
          onClick={onSchemaClick}
          className="text-muted text-xs hover:text-foreground cursor-pointer"
        >
          Schema
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <p className="text-muted text-xs p-3">Loading…</p>}
        {!loading && products.length === 0 && (
          <p className="text-muted text-xs p-3">No products</p>
        )}
        {products.map(p => (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className={cn(
              'w-full text-left px-3 py-2 text-sm border-b border-border/50 truncate transition-colors',
              selectedId === p.id
                ? 'bg-surface-2 text-foreground'
                : 'text-muted hover:bg-surface-2 hover:text-foreground'
            )}
          >
            {p.name}
          </button>
        ))}
        {!loading && (
          <button
            onClick={() => onSelect(NO_PRODUCT_ID)}
            className={cn(
              'w-full text-left px-3 py-2 text-sm truncate transition-colors italic',
              selectedId === NO_PRODUCT_ID
                ? 'bg-surface-2 text-foreground'
                : 'text-muted hover:bg-surface-2 hover:text-foreground'
            )}
          >
            No product
          </button>
        )}
      </div>
    </div>
  )
}
