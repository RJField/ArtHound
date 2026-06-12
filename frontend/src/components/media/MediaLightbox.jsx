import { useEffect } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import ImageViewer from './ImageViewer'
import VideoViewer from './VideoViewer'
import PdfViewer from './PdfViewer'
import DocumentCard from './DocumentCard'
import { viewerType } from './mediaUtils'

export default function MediaLightbox({ items, activeIndex, onClose, onPrev, onNext }) {
  const item = items[activeIndex]

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft'  && activeIndex > 0) onPrev()
      if (e.key === 'ArrowRight' && activeIndex < items.length - 1) onNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeIndex, items.length, onClose, onPrev, onNext])

  if (!item) return null

  const type = viewerType(item.mimetype, item.filename)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative w-full max-w-5xl max-h-[90vh] flex flex-col bg-surface rounded-lg overflow-hidden shadow-(--ah-shadow-lg) m-4">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border-soft shrink-0">
          <span className="text-foreground text-sm font-medium truncate">{item.filename}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md hover:bg-surface-2 text-muted hover:text-foreground cursor-pointer ml-2 shrink-0 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Viewer */}
        <div className="flex-1 min-h-0 overflow-hidden" style={{ minHeight: '60vh' }}>
          {!item.proxyUrl ? (
            <div className="flex items-center justify-center h-full text-muted text-sm">
              Processing — check back shortly
            </div>
          ) : type === 'image' ? (
            <ImageViewer proxyUrl={item.proxyUrl} filename={item.filename} />
          ) : type === 'video' ? (
            <VideoViewer proxyUrl={item.proxyUrl} filename={item.filename} />
          ) : type === 'pdf' ? (
            <PdfViewer proxyUrl={item.proxyUrl} />
          ) : (
            <div className="flex items-center justify-center h-full p-8">
              <DocumentCard {...item} compact={false} />
            </div>
          )}
        </div>

        {/* Prev/next */}
        {items.length > 1 && (
          <>
            <button
              onClick={onPrev}
              disabled={activeIndex <= 0}
              className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-surface-2/80 text-muted hover:text-foreground disabled:opacity-0 transition-opacity"
            >
              <ChevronLeft size={20} />
            </button>
            <button
              onClick={onNext}
              disabled={activeIndex >= items.length - 1}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-surface-2/80 text-muted hover:text-foreground disabled:opacity-0 transition-opacity"
            >
              <ChevronRight size={20} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
