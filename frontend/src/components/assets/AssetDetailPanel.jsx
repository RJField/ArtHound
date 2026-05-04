import { useState } from 'react'
import { cn } from '../../lib/utils'
import DetailsTab from './tabs/DetailsTab'
import WorkTab    from './tabs/WorkTab'
import ReviewsTab from './tabs/ReviewsTab'
import BugsTab    from './tabs/BugsTab'

// Tab registry — add, remove, or reorder here without touching panel logic.
const TABS = [
  { id: 'details', label: 'Details', Component: DetailsTab },
  { id: 'work',    label: 'Work',    Component: WorkTab },
  { id: 'reviews', label: 'Reviews', Component: ReviewsTab },
  { id: 'bugs',    label: 'Bugs',    Component: BugsTab },
]

export default function AssetDetailPanel({ asset, schema, workRefreshKey }) {
  const [activeTab, setActiveTab] = useState('details')

  const { Component: ActiveComponent } = TABS.find(t => t.id === activeTab) ?? {}

  return (
    <div className="w-96 shrink-0 flex flex-col overflow-hidden">

      {!asset ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-muted text-xs">Select an asset</p>
        </div>
      ) : (
        <>
          {/* Asset header */}
          <div className="px-4 pt-4 pb-3 border-b border-border shrink-0">
            <h2 className="text-foreground font-semibold text-sm leading-snug truncate">
              {asset.name || '—'}
            </h2>
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              {asset.itemType && (
                <span className="text-xs bg-surface-2 text-muted px-2 py-0.5 rounded-full">
                  {asset.itemType}
                </span>
              )}
              {asset.priority != null && (
                <span className="text-xs bg-surface-2 text-muted px-2 py-0.5 rounded-full">
                  P{asset.priority}
                </span>
              )}
              {asset.assetNumber && (
                <span className="text-xs text-muted">#{asset.assetNumber}</span>
              )}
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex border-b border-border shrink-0 overflow-x-auto">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'px-4 py-2 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap border-b-2 -mb-px',
                  activeTab === tab.id
                    ? 'border-accent text-foreground'
                    : 'border-transparent text-muted hover:text-foreground'
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Active tab content */}
          <div className="flex-1 overflow-hidden">
            {ActiveComponent && (
              <ActiveComponent asset={asset} schema={schema} workRefreshKey={workRefreshKey} />
            )}
          </div>
        </>
      )}
    </div>
  )
}
