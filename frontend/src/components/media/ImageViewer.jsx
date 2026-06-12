import { useState } from 'react'
import { Clock } from 'lucide-react'
import { Spinner } from '../ui'
import { useMediaUrl } from '../../hooks/useMediaUrl'

export default function ImageViewer({ proxyUrl, filename }) {
  const [zoomed, setZoomed] = useState(false)
  const { blobUrl, loading, error, pending } = useMediaUrl(proxyUrl)

  if (pending) {
    return (
      <div className="flex flex-col items-center justify-center w-full h-full gap-2 text-muted">
        <Clock size={24} />
        <p className="text-sm">Attachment is still being processed — check back shortly.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center w-full h-full">
        <Spinner size={24} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center w-full h-full gap-1 text-muted text-sm">
        <span>Failed to load image.</span>
        <span className="text-xs text-faint">{error}</span>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center w-full h-full min-h-0 overflow-auto p-4">
      <img
        src={blobUrl}
        alt={filename}
        onClick={() => setZoomed(z => !z)}
        className={`max-h-full object-contain transition-transform duration-200 ${
          zoomed ? 'scale-150 cursor-zoom-out' : 'cursor-zoom-in'
        }`}
      />
    </div>
  )
}
