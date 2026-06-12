import { useState, useMemo } from 'react'
import { MousePointerClick } from 'lucide-react'
import { formatRawFields } from '../../lib/fields'
import { priorityColor } from '../../lib/statusColors'
import { EmptyState, Pill, StatusDot, Tabs } from '../ui'
import DetailsTab     from './tabs/DetailsTab'
import WorkTab        from './tabs/WorkTab'
import ReviewsTab     from './tabs/ReviewsTab'
import BugsTab        from './tabs/BugsTab'
import AttachmentsTab from './tabs/AttachmentsTab'

const TABS = [
  { id: 'details',     label: 'Details',     Component: DetailsTab },
  { id: 'attachments', label: 'Attachments', Component: AttachmentsTab },
  { id: 'work',        label: 'Work',        Component: WorkTab },
  { id: 'reviews',     label: 'Reviews',     Component: ReviewsTab },
  { id: 'bugs',        label: 'Bugs',        Component: BugsTab },
]

export default function AssetDetailPanel({ asset, schema, workRefreshKey }) {
  const [activeTab, setActiveTab] = useState('details')

  const attachmentCount = useMemo(() => {
    if (!asset?.rawFields) return 0
    return formatRawFields(asset.rawFields).filter(f => f.type === 'attachments')
      .reduce((sum, g) => sum + (g.items?.length ?? 0), 0)
  }, [asset?.id])

  const tabs = TABS.map(t => ({
    id: t.id,
    label: t.label,
    count: t.id === 'attachments' && attachmentCount ? attachmentCount : undefined,
  }))

  const { Component: ActiveComponent } = TABS.find(t => t.id === activeTab) ?? {}

  return (
    <div className="w-96 shrink-0 flex flex-col overflow-hidden">

      {!asset ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState icon={MousePointerClick} title="Select an asset" />
        </div>
      ) : (
        <>
          {/* Asset header */}
          <div className="px-4 pt-4 pb-3 border-b border-border shrink-0">
            <h2 className="text-foreground font-semibold text-sm leading-snug truncate">
              {asset.name || '—'}
            </h2>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {asset.itemType && (
                <Pill tone="neutral">{asset.itemType}</Pill>
              )}
              {asset.priority != null && (
                <StatusDot
                  label={`P${asset.priority}`}
                  color={priorityColor(asset.priority)}
                  className="text-xs text-foreground"
                />
              )}
              {asset.assetNumber && (
                <span className="font-mono text-xs text-muted">#{asset.assetNumber}</span>
              )}
            </div>
          </div>

          {/* Tab bar */}
          <Tabs
            tabs={tabs}
            active={activeTab}
            onChange={setActiveTab}
            className="shrink-0"
          />

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
