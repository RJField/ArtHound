import { Loader2, Clock } from 'lucide-react'
import { useMediaUrl } from '../../hooks/useMediaUrl'

export default function VideoViewer({ proxyUrl, filename }) {
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
        <Loader2 className="text-muted animate-spin" size={24} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center w-full h-full text-muted text-sm">
        Failed to load video.
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center w-full h-full p-4">
      <video
        controls
        src={blobUrl}
        title={filename}
        className="max-w-full max-h-full rounded"
      />
    </div>
  )
}
