import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Inbox } from 'lucide-react'
import { apiFetch, payloadAttachmentUrl } from '../lib/api'
import { formatRawFields, fieldDisplayString } from '../lib/fields'
import DetailModal from '../components/DetailModal'
import IngestModal from '../components/IngestModal'
import PageContainer from '../components/PageContainer'
import { Button, Pill, Card, PageHeader, EmptyState, Spinner } from '../components/ui'

const SKIP = new Set(['Name', 'name'])

function buildModalProps(d, onIngest) {
  const data          = d.payload_data?.data ?? {}
  const assetGlobalId = d.payload_data?.asset_global_id
  const name          = data['Name'] || data['name'] || '—'
  const itemType      = fieldDisplayString(data['Item Type'] || data['item_type'] || '')
  const priority      = d.payload_data?.priority
  const studio        = d.payload_data?.sender_studio_name || 'Unknown Studio'
  const date          = d.created_at ? new Date(d.created_at).toLocaleDateString() : '—'
  const badge         = [itemType, priority != null ? `P${priority}` : ''].filter(Boolean).join(' · ')
  const raw           = Object.fromEntries(Object.entries(data).filter(([k]) => !SKIP.has(k)))

  const proxyUrlFn = assetGlobalId
    ? (fieldKey, idx) => payloadAttachmentUrl(d.id, assetGlobalId, fieldKey, idx)
    : null

  const isIngested = !!d.payload_field_mappings?.[0]?.ingested_at
  const isFailed   = !isIngested && !!d.payload_field_mappings?.[0]?.failed_at

  return {
    title:  name,
    badge:  badge || undefined,
    fields: [
      { label: 'From',     value: studio },
      { label: 'Received', value: date },
      ...formatRawFields(raw, proxyUrlFn),
    ],
    actions: [
      {
        label: isIngested ? 'Ingested ✓' : isFailed ? 'Link Failed — Retry' : 'Ingest to Source',
        style: isIngested ? undefined : 'primary',
        onClick: closeFn => {
          closeFn()
          onIngest()
        },
      },
    ],
  }
}

export default function VendorInbox() {
  const [dispatches, setDispatches]   = useState([])
  const [loading, setLoading]         = useState(true)
  const [activeModal, setActiveModal] = useState(null)   // DetailModal props
  const [ingestId, setIngestId]       = useState(null)   // dispatch ID for IngestModal

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/api/payloads/vendor-inbox')
      setDispatches(data)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load]) // eslint-disable-line react-hooks/set-state-in-effect

  function openDispatch(d) {
    apiFetch(`/api/payloads/${encodeURIComponent(d.id)}/viewed`, { method: 'POST' }).catch(() => {})
    setActiveModal(buildModalProps(d, () => setIngestId(d.id)))
  }

  function handleIngested(dispatchId, sourceRecordId) {
    // Mark the dispatch as ingested in local state so the badge updates immediately
    setDispatches(prev => prev.map(d => {
      if (d.id !== dispatchId) return d
      return {
        ...d,
        payload_field_mappings: [
          { ingested_at: new Date().toISOString(), ingested_source_record_id: sourceRecordId },
        ],
      }
    }))
  }

  return (
    <PageContainer width="lg" className="p-6 gap-4">
      <PageHeader
        title="Incoming Scope"
        subtitle="Asset payloads dispatched to you by connected studios."
        actions={
          <Button variant="ghost" onClick={load}>
            Refresh
          </Button>
        }
      />

      {loading && (
        <div className="flex items-center gap-2 text-muted text-sm">
          <Spinner /> Loading…
        </div>
      )}

      {!loading && dispatches.length === 0 && (
        <EmptyState
          icon={Inbox}
          title="No incoming assets yet"
          hint="Dispatches from connected studios will appear here."
        />
      )}

      {!loading && dispatches.length > 0 && (
        <div className="flex flex-col gap-2">
          {dispatches.map(d => {
            const data      = d.payload_data?.data ?? {}
            const name      = data['Name'] || data['name'] || '—'
            const itemType  = fieldDisplayString(data['Item Type'] || data['item_type'] || '')
            const priority  = d.payload_data?.priority
            const studio    = d.payload_data?.sender_studio_name || 'Unknown Studio'
            const date      = d.created_at ? new Date(d.created_at).toLocaleDateString() : '—'
            const isIngested = !!d.payload_field_mappings?.[0]?.ingested_at
            const isFailed   = !isIngested && !!d.payload_field_mappings?.[0]?.failed_at

            return (
              <div key={d.id} onClick={() => openDispatch(d)} className="cursor-pointer">
                <Card
                  pad={false}
                  className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-surface-2 transition-colors"
                >
                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="text-foreground text-sm font-medium truncate">{name}</span>
                    <div className="flex items-center gap-2 flex-wrap">
                      {itemType && <Pill tone="neutral">{itemType}</Pill>}
                      {priority != null && <Pill tone="neutral">P{priority}</Pill>}
                      {isIngested && <Pill tone="success">Ingested</Pill>}
                      {isFailed && <Pill tone="error">Link Failed</Pill>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="flex flex-col items-end gap-1 text-xs text-muted">
                      <span>{studio}</span>
                      <span>{date}</span>
                    </div>
                    <Button size="sm" disabled onClick={e => e.stopPropagation()}>
                      Request Refresh
                    </Button>
                  </div>
                </Card>
              </div>
            )
          })}
        </div>
      )}

      {activeModal && (
        <DetailModal {...activeModal} onClose={() => setActiveModal(null)} />
      )}

      {ingestId && (
        <IngestModal
          dispatchId={ingestId}
          onClose={() => setIngestId(null)}
          onIngested={handleIngested}
        />
      )}
    </PageContainer>
  )
}
