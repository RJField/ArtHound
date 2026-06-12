import { Package } from 'lucide-react'
import { cn } from '../../lib/utils'
import { NO_PRODUCT_ID } from '../../hooks/useAssets'
import { Button, EmptyState, SectionLabel, Spinner } from '../ui'

export default function ProductSidebar({ products, loading, selectedId, onSelect, onSchemaClick }) {
  return (
    <div className="w-44 border-r border-border flex flex-col shrink-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface shrink-0">
        <SectionLabel>Products</SectionLabel>
        <Button variant="ghost" size="sm" onClick={onSchemaClick}>
          Schema
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )}
        {!loading && products.length === 0 && (
          <EmptyState icon={Package} title="No products" />
        )}
        {products.map(p => (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className={cn(
              'w-full text-left px-3 py-2 text-sm border-b border-border-soft truncate transition-colors',
              selectedId === p.id
                ? 'bg-accent-tint text-foreground shadow-[inset_2px_0_0_var(--color-accent)]'
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
                ? 'bg-accent-tint text-foreground shadow-[inset_2px_0_0_var(--color-accent)]'
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
