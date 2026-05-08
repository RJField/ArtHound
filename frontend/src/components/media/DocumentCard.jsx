import { File, FileText, Film, Image, Download, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { apiFetchRaw } from '../../lib/api'
import { resolveMimetype } from './mediaUtils'

function iconForMimetype(mimetype, filename) {
  const mt = resolveMimetype(mimetype, filename)
  if (!mt) return File
  if (mt.startsWith('image/')) return Image
  if (mt.startsWith('video/')) return Film
  if (mt === 'application/pdf') return FileText
  return File
}

function fmtSize(bytes) {
  if (!bytes) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function DocumentCard({ filename, mimetype, size_bytes, proxyUrl, compact = false }) {
  const [downloading, setDownloading] = useState(false)
  const Icon = iconForMimetype(mimetype, filename)
  const size = fmtSize(size_bytes)

  async function handleDownload(e) {
    e.stopPropagation()
    if (!proxyUrl || downloading) return
    setDownloading(true)
    try {
      const r = await apiFetchRaw(proxyUrl)
      if (!r.ok) throw new Error(r.statusText)
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      // silently ignore — proxy errors are visible in the viewer
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className={`flex items-center gap-3 ${compact ? '' : 'p-4 bg-surface-2/60 rounded-lg border border-border/40'}`}>
      <Icon className="text-muted shrink-0" size={compact ? 20 : 32} />
      <div className="flex-1 min-w-0">
        <p className="text-foreground text-sm truncate">{filename}</p>
        {size && <p className="text-muted text-xs">{size}</p>}
      </div>
      {proxyUrl && (
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="text-muted hover:text-foreground disabled:opacity-50 shrink-0"
        >
          {downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
        </button>
      )}
    </div>
  )
}
