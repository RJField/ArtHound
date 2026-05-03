import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'

const TYPE_LABEL = {
  text: 'text', number: 'num', date: 'date', link: 'link',
  computed: 'calc', select: 'select', bool: 'bool', user: 'user',
  file: 'file', other: '…',
}

const TYPE_COLOR = {
  text: 'text-p2', number: 'text-p3', date: 'text-p4', link: 'text-p2',
  computed: 'text-muted', select: 'text-accent', bool: 'text-p1',
  user: 'text-p2', file: 'text-p4',
}

export default function SchemaModal({ onClose }) {
  const [data, setData]         = useState(null)
  const [activeKey, setActiveKey] = useState(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)

  useEffect(() => {
    apiFetch('/api/schema')
      .then(d => { setData(d); setActiveKey(d.configured[0]?.key ?? null) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const activeTable = data?.configured.find(t => t.key === activeKey)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-foreground text-base font-semibold">Schema</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground text-xl cursor-pointer leading-none">×</button>
        </div>

        {loading && <p className="text-muted text-sm p-5">Loading schema…</p>}
        {error   && <p className="text-error text-sm p-5">{error}</p>}

        {data && (
          <>
            {/* Tabs */}
            <div className="flex gap-1 px-4 pt-3 shrink-0 flex-wrap">
              {data.configured.map(t => (
                <button
                  key={t.key}
                  onClick={() => setActiveKey(t.key)}
                  className={cn(
                    'px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors flex items-center gap-1',
                    activeKey === t.key
                      ? 'bg-surface-2 text-foreground'
                      : 'text-muted hover:text-foreground'
                  )}
                >
                  {t.key}
                  {!t.found && <span className="text-error text-xs">!</span>}
                </button>
              ))}
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-4">
              {activeTable && <TableFields table={activeTable} allNames={data.allTableNames} />}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function TableFields({ table, allNames }) {
  if (!table.found) {
    const suggestions = allNames.filter(n =>
      n.toLowerCase().includes(table.key) ||
      table.name.toLowerCase().includes(n.toLowerCase().slice(0, 5))
    ).slice(0, 5)

    return (
      <div className="flex flex-col gap-2">
        <p className="text-error text-sm font-medium">Table not found</p>
        <p className="text-muted text-xs">
          Configured as <code className="bg-surface-2 px-1 rounded">{table.name}</code> — set{' '}
          <code className="bg-surface-2 px-1 rounded">TABLE_{table.key.toUpperCase()}</code> in <code className="bg-surface-2 px-1 rounded">.env</code> to override.
        </p>
        {suggestions.length > 0 && (
          <p className="text-muted text-xs">
            Tables in this base: {suggestions.map(n => (
              <code key={n} className="bg-surface-2 px-1 rounded mr-1">{n}</code>
            ))}
          </p>
        )}
      </div>
    )
  }

  const isTemplates    = table.key === 'templates'
  const estimateCols   = isTemplates ? table.fields.filter(f => f.name.includes('Template Estimate')) : []
  const regularFields  = isTemplates ? table.fields.filter(f => !f.name.includes('Template Estimate')) : table.fields

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="text-foreground text-sm font-medium">{table.name}</span>
        <span className="text-muted text-xs px-2 py-0.5 rounded-full bg-surface-2">
          {table.fields.length} field{table.fields.length !== 1 ? 's' : ''}
        </span>
        <span className="text-muted text-xs font-mono">{table.id}</span>
      </div>

      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left text-muted font-normal pb-1.5 pr-4">Field name</th>
            <th className="text-left text-muted font-normal pb-1.5 pr-4 w-16">Type</th>
            <th className="text-left text-muted font-normal pb-1.5 font-mono">Field ID</th>
          </tr>
        </thead>
        <tbody>
          {regularFields.map(f => <FieldRow key={f.id} field={f} />)}
          {estimateCols.length > 0 && (
            <>
              <tr>
                <td colSpan={3} className="py-2 text-muted text-xs border-t border-border">
                  Estimate columns ({estimateCols.length})
                </td>
              </tr>
              {estimateCols.map(f => <FieldRow key={f.id} field={f} />)}
            </>
          )}
        </tbody>
      </table>
    </div>
  )
}

function FieldRow({ field }) {
  const label = TYPE_LABEL[field.category] ?? field.type
  const color = TYPE_COLOR[field.category] ?? 'text-muted'
  return (
    <tr className="border-b border-border/40">
      <td className="py-1.5 pr-4 text-foreground">{field.name}</td>
      <td className="py-1.5 pr-4">
        <span className={cn('font-mono', color)}>{label}</span>
      </td>
      <td className="py-1.5 text-muted font-mono">{field.id}</td>
    </tr>
  )
}
