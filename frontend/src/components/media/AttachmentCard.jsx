import { File, FileText, Film, Clock, Loader2 } from 'lucide-react'
import { useMediaUrl } from '../../hooks/useMediaUrl'
import { viewerType } from './mediaUtils'

function Thumbnail({ proxyUrl, filename, type }) {
  const { blobUrl, loading } = useMediaUrl(type === 'image' ? proxyUrl : null)

  if (type === 'image') {
    if (loading) return <Loader2 size={16} className="text-muted animate-spin" />
    if (blobUrl) return <img src={blobUrl} alt={filename} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200" loading="lazy" />
    return <File size={20} className="text-muted" />
  }
  if (type === 'video') return <Film size={20} className="text-muted" />
  if (type === 'pdf')   return <FileText size={20} className="text-muted" />
  return <File size={20} className="text-muted" />
}

export default function AttachmentCard({ filename, mimetype, size_bytes: _, proxyUrl, onClick }) {
  const type    = viewerType(mimetype, filename)
  const pending = !proxyUrl

  return (
    <button
      onClick={!pending ? onClick : undefined}
      disabled={pending}
      className="group w-28 flex flex-col rounded-lg border border-border/40 overflow-hidden bg-surface-2/40 hover:border-border transition-colors disabled:opacity-60 disabled:cursor-default text-left"
    >
      <div className="w-full h-20 flex items-center justify-center bg-surface-2 overflow-hidden">
        {pending
          ? <Clock size={18} className="text-muted" />
          : <Thumbnail proxyUrl={proxyUrl} filename={filename} type={type} />
        }
      </div>
      <div className="px-2 py-1.5 w-full">
        <p className="text-xs text-foreground truncate" title={filename}>{filename}</p>
        {pending && <p className="text-xs text-muted">Processing…</p>}
      </div>
    </button>
  )
}
