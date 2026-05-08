import { useState, useRef } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl w-full max-w-lg flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-foreground text-base font-semibold">CSV Import</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground text-xl cursor-pointer leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {phase === 'drop' && (
            <div
              className={cn(
                'border-2 border-dashed rounded-xl p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors',
                dragOver ? 'border-accent bg-accent/5' : 'border-border hover:border-muted'
              )}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]) }}
              onClick={() => fileRef.current?.click()}
            >
              <span className="text-3xl text-muted">⬆</span>
              <div className="text-center">
                <p className="text-foreground text-sm">Drop a CSV file here or <span className="text-accent">browse</span></p>
                <p className="text-muted text-xs mt-1">Use the format exported from the setup wizard (Task column + estimate columns)</p>
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
                <span className="text-muted text-xs">{rows.length} row{rows.length !== 1 ? 's' : ''}</span>
              </div>

              {workIdx === -1 && (
                <div className="text-xs text-error bg-error/10 border border-error/20 rounded-md px-3 py-2">
                  ⚠ No "Work" or "Task" column found — check the file format
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-muted text-xs font-medium uppercase tracking-wide mb-2">Estimate columns detected</p>
                  {estCols.length
                    ? <div className="flex flex-wrap gap-1">
                        {estCols.map(h => (
                          <span key={h} className="text-xs bg-surface-2 border border-border text-foreground px-2 py-0.5 rounded">{h}</span>
                        ))}
                      </div>
                    : <p className="text-muted text-xs">None found</p>
                  }
                </div>
                <div>
                  <p className="text-muted text-xs font-medium uppercase tracking-wide mb-2">First work items in file</p>
                  <div className="flex flex-col gap-1">
                    {rows.slice(0, 5).map((r, i) => (
                      <div key={i} className="text-foreground text-xs">{r[workIdx] ?? '—'}</div>
                    ))}
                    {rows.length > 5 && <div className="text-muted text-xs">+ {rows.length - 5} more</div>}
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
                <div className="text-xs text-error bg-error/10 border border-error/20 rounded-md px-3 py-2 w-full">
                  ⚠ {result.notFound.length} task{result.notFound.length !== 1 ? 's' : ''} not matched: {result.notFound.join(', ')}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-border shrink-0">
          <div>
            {phase === 'preview' && (
              <button onClick={reset} className="text-xs text-muted hover:text-foreground px-3 py-1.5 rounded-md border border-border cursor-pointer">← Change file</button>
            )}
            {phase === 'result' && (
              <button onClick={reset} className="text-xs text-muted hover:text-foreground px-3 py-1.5 rounded-md border border-border cursor-pointer">← Import another</button>
            )}
          </div>
          <div>
            {phase === 'preview' && (
              <button
                onClick={applyImport}
                disabled={workIdx === -1 || !estCols.length || loading}
                className="text-xs bg-accent text-white px-3 py-1.5 rounded-md font-medium hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
              >
                {loading ? 'Importing…' : `Import ${nonEmpty.length} row${nonEmpty.length !== 1 ? 's' : ''}`}
              </button>
            )}
            {phase === 'result' && (
              <button onClick={onClose} className="text-xs text-muted hover:text-foreground px-3 py-1.5 rounded-md border border-border cursor-pointer">Close</button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
