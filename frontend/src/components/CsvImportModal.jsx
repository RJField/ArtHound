import { useState, useRef } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'
import { Button, Modal, Pill, SectionLabel } from './ui'

function parseCSV(raw) {
  const rows = []
  let row = [], cell = '', inQ = false
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n') + '\n'
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') { inQ = false }
      else { cell += c }
    } else {
      if (c === '"') { inQ = true }
      else if (c === ',') { row.push(cell); cell = '' }
      else if (c === '\n') {
        row.push(cell); cell = ''
        if (row.some(v => v !== '')) rows.push(row)
        row = []
      } else { cell += c }
    }
  }
  return rows
}

export default function CsvImportModal({ onClose }) {
  const [phase, setPhase] = useState('drop') // 'drop' | 'preview' | 'result'
  const [csv, setCsv] = useState(null)       // { headers, rows, fileName }
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef(null)

  function handleFile(file) {
    const reader = new FileReader()
    reader.onload = e => {
      const parsed = parseCSV(e.target.result)
      if (!parsed.length) { toast.error('CSV appears to be empty'); return }
      setCsv({
        headers: parsed[0],
        rows: parsed.slice(1).filter(r => r.some(v => v.trim())),
        fileName: file.name,
      })
      setPhase('preview')
    }
    reader.readAsText(file)
  }

  const headers = csv?.headers ?? []
  const rows    = csv?.rows ?? []
  const workIdx = headers.indexOf('Work') !== -1 ? headers.indexOf('Work') : headers.indexOf('Task')
  const estCols = headers.filter((h, i) => i !== workIdx && h.trim())
  const nonEmpty = rows.filter(r =>
    estCols.some(h => {
      const v = (r[headers.indexOf(h)] ?? '').trim()
      return v !== '' && !isNaN(parseFloat(v))
    })
  )


  async function applyImport() {
    setLoading(true)
    try {
      const res = await apiFetch('/api/setup/import-csv', {
        method: 'POST',
        body: JSON.stringify({ headers, rows }),
      })
      setResult(res)
      setPhase('result')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  function reset() {
    setCsv(null)
    setResult(null)
    setPhase('drop')
  }

  return (
    <Modal
      title="CSV Import"
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          {phase === 'preview' && (
            <Button size="lg" className="mr-auto" onClick={reset}>← Change file</Button>
          )}
          {phase === 'result' && (
            <Button size="lg" className="mr-auto" onClick={reset}>← Import another</Button>
          )}
          {phase === 'preview' && (
            <Button
              variant="primary"
              size="lg"
              onClick={applyImport}
              disabled={workIdx === -1 || !estCols.length || loading}
            >
              {loading ? 'Importing…' : `Import ${nonEmpty.length} row${nonEmpty.length !== 1 ? 's' : ''}`}
            </Button>
          )}
          {phase === 'result' && (
            <Button size="lg" onClick={onClose}>Close</Button>
          )}
        </>
      }
    >
      {phase === 'drop' && (
        <div
          className={cn(
            'border-2 border-dashed rounded-lg p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors',
            dragOver ? 'border-accent bg-accent-tint' : 'border-border hover:border-muted'
          )}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]) }}
          onClick={() => fileRef.current?.click()}
        >
          <span className="text-3xl text-muted">⬆</span>
          <div className="text-center">
            <p className="text-foreground text-sm">Drop a CSV file here or <span className="text-link hover:underline">browse</span></p>
            <p className="text-faint text-xs mt-1">Use the format exported from the setup wizard (Task column + estimate columns)</p>
          </div>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
            onChange={e => { if (e.target.files[0]) handleFile(e.target.files[0]) }} />
        </div>
      )}

      {phase === 'preview' && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <span className="text-lg">📄</span>
            <span className="text-foreground text-sm font-medium">{csv.fileName}</span>
            <span className="text-faint text-xs tabular-nums">{rows.length} row{rows.length !== 1 ? 's' : ''}</span>
          </div>

          {workIdx === -1 && (
            <div className="text-xs text-error bg-error-tint border border-error/25 rounded-md px-3 py-2">
              ⚠ No "Work" or "Task" column found — check the file format
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <SectionLabel className="mb-2">Estimate columns detected</SectionLabel>
              {estCols.length
                ? <div className="flex flex-wrap gap-1">
                    {estCols.map(h => (
                      <Pill key={h} tone="neutral">{h}</Pill>
                    ))}
                  </div>
                : <p className="text-muted text-xs">None found</p>
              }
            </div>
            <div>
              <SectionLabel className="mb-2">First work items in file</SectionLabel>
              <div className="flex flex-col gap-1">
                {rows.slice(0, 5).map((r, i) => (
                  <div key={i} className="text-foreground text-xs">{r[workIdx] ?? '—'}</div>
                ))}
                {rows.length > 5 && <div className="text-faint text-xs">+ {rows.length - 5} more</div>}
              </div>
            </div>
          </div>

          <p className="text-muted text-xs">{nonEmpty.length} of {rows.length} rows have values to write</p>
        </div>
      )}

      {phase === 'result' && result && (
        <div className="flex flex-col items-center gap-3 py-6">
          <span className="text-success text-3xl">✓</span>
          <p className="text-foreground text-sm font-semibold">Import complete</p>
          <div className="flex items-center gap-3">
            <span className="text-foreground text-sm font-medium">{result.updated} task{result.updated !== 1 ? 's' : ''} updated</span>
            <span className="text-muted text-sm">{result.cellsWritten} cell{result.cellsWritten !== 1 ? 's' : ''} written</span>
          </div>
          {result.notFound?.length > 0 && (
            <div className="text-xs text-error bg-error-tint border border-error/25 rounded-md px-3 py-2 w-full">
              ⚠ {result.notFound.length} task{result.notFound.length !== 1 ? 's' : ''} not matched: {result.notFound.join(', ')}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
