import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { Modal, Tabs, Spinner, Table, Th, Tr, Td, Pill } from './ui'

const TYPE_LABEL = {
  text: 'text', number: 'num', date: 'date', link: 'link',
  computed: 'calc', select: 'select', bool: 'bool', user: 'user',
  file: 'file', other: '…',
}

export default function SchemaModal({ onClose }) {
  const [data, setData]         = useState(null)
  const [activeKey, setActiveKey] = useState(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    apiFetch('/api/schema', { signal: controller.signal })
      .then(d => { setData(d); setActiveKey(d.configured[0]?.key ?? null) })
      .catch(e => { if (e.name !== 'AbortError') setError(e.message) })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [])

  const activeTable = data?.configured.find(t => t.key === activeKey)

  return (
    <Modal
      title="Schema"
      onClose={onClose}
      width="max-w-3xl"
      bodyClassName="p-0 overflow-hidden flex flex-col"
    >
      {loading && (
        <div className="flex items-center gap-2 p-5 text-muted text-sm">
          <Spinner size={14} /> Loading schema…
        </div>
      )}
      {error && <p className="text-error text-sm p-5">{error}</p>}

      {data && (
        <>
          <Tabs
            className="px-4 shrink-0"
            tabs={data.configured.map(t => ({
              id: t.key,
              label: (
                <span className="inline-flex items-center gap-1">
                  {t.key}
                  {!t.found && <span className="text-error">!</span>}
                </span>
              ),
            }))}
            active={activeKey}
            onChange={setActiveKey}
          />

          <div className="flex-1 overflow-y-auto p-4">
            {activeTable && <TableFields table={activeTable} allNames={data.allTableNames} />}
          </div>
        </>
      )}
    </Modal>
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
        <Pill tone="neutral">
          {table.fields.length} field{table.fields.length !== 1 ? 's' : ''}
        </Pill>
        <span className="text-faint text-xs font-mono">{table.id}</span>
      </div>

      <Table>
        <thead>
          <tr>
            <Th>Field name</Th>
            <Th className="w-16">Type</Th>
            <Th>Field ID</Th>
          </tr>
        </thead>
        <tbody>
          {regularFields.map(f => <FieldRow key={f.id} field={f} />)}
          {estimateCols.length > 0 && (
            <>
              <tr>
                <td colSpan={3} className="py-2 px-2.5 text-faint text-xs border-t border-b border-border-soft">
                  Estimate columns ({estimateCols.length})
                </td>
              </tr>
              {estimateCols.map(f => <FieldRow key={f.id} field={f} />)}
            </>
          )}
        </tbody>
      </Table>
    </div>
  )
}

function FieldRow({ field }) {
  const label = TYPE_LABEL[field.category] ?? field.type
  return (
    <Tr>
      <Td primary className="font-normal text-foreground">{field.name}</Td>
      <Td>
        <span className="font-mono text-faint">{label}</span>
      </Td>
      <Td className="font-mono">{field.id}</Td>
    </Tr>
  )
}
