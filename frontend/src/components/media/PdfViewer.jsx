import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Loader2, Clock } from 'lucide-react'
import { useMediaUrl } from '../../hooks/useMediaUrl'

let _pdfjsLib = null

async function getPdfjsLib() {
  if (!_pdfjsLib) {
    _pdfjsLib = await import('pdfjs-dist')
    _pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString()
  }
  return _pdfjsLib
}

export default function PdfViewer({ proxyUrl, fitWidth = false }) {
  const { blobUrl, loading: fetching, error: fetchError, pending } = useMediaUrl(proxyUrl)

  const [pdf, setPdf]                 = useState(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [scale, setScale]             = useState(1.5)
  const [rendering, setRendering]     = useState(false)
  const [renderError, setRenderError] = useState(null)
  const canvasRef                     = useRef(null)
  const renderTaskRef                 = useRef(null)
  const scrollRef                     = useRef(null)

  useEffect(() => {
    if (!blobUrl) { setPdf(null); return }
    let cancelled = false
    setRenderError(null)

    getPdfjsLib()
      .then(lib => lib.getDocument(blobUrl).promise)
      .then(doc => {
        if (!cancelled) { setPdf(doc); setCurrentPage(1) }
      })
      .catch(() => {
        if (!cancelled) setRenderError('Could not parse PDF.')
      })

    return () => { cancelled = true }
  }, [blobUrl])

  // Auto-scale to container width when fitWidth is enabled.
  useEffect(() => {
    if (!fitWidth || !pdf || !scrollRef.current) return
    let cancelled = false

    async function calcScale() {
      const page = await pdf.getPage(1)
      const naturalWidth = page.getViewport({ scale: 1 }).width
      const containerWidth = scrollRef.current?.clientWidth ?? 0
      if (containerWidth > 0 && !cancelled) {
        // 32px accounts for p-4 padding on each side
        setScale(Math.max(0.5, Math.min(3, +((containerWidth - 32) / naturalWidth).toFixed(2))))
      }
    }

    const observer = new ResizeObserver(() => calcScale())
    observer.observe(scrollRef.current)
    calcScale()
    return () => { cancelled = true; observer.disconnect() }
  }, [pdf, fitWidth])

  const renderPage = useCallback(async (pageNum) => {
    if (!pdf || !canvasRef.current) return
    if (renderTaskRef.current) renderTaskRef.current.cancel()
    setRendering(true)

    const page     = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale })
    const canvas   = canvasRef.current
    canvas.width   = viewport.width
    canvas.height  = viewport.height

    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport })
    renderTaskRef.current = task
    try {
      await task.promise
    } catch (e) {
      if (e.name !== 'RenderingCancelledException') throw e
    } finally {
      setRendering(false)
    }
  }, [pdf, scale])

  useEffect(() => { renderPage(currentPage) }, [renderPage, currentPage])

  if (pending) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted">
        <Clock size={24} />
        <p className="text-sm">Attachment is still being processed — check back shortly.</p>
      </div>
    )
  }

  if (fetching || (!blobUrl && !fetchError)) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="text-muted animate-spin" size={24} />
      </div>
    )
  }

  if (fetchError || renderError) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        {fetchError || renderError}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/40 shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="p-1 rounded hover:bg-surface-2 disabled:opacity-30 text-muted"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-xs text-muted">{currentPage} / {pdf?.numPages ?? '…'}</span>
          <button
            onClick={() => setCurrentPage(p => Math.min(pdf?.numPages ?? p, p + 1))}
            disabled={!pdf || currentPage >= pdf.numPages}
            className="p-1 rounded hover:bg-surface-2 disabled:opacity-30 text-muted"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setScale(s => Math.max(0.5, +(s - 0.25).toFixed(2)))}
            className="p-1 rounded hover:bg-surface-2 text-muted"
          >
            <ZoomOut size={16} />
          </button>
          <span className="text-xs text-muted w-10 text-center">{Math.round(scale * 100)}%</span>
          <button
            onClick={() => setScale(s => Math.min(3, +(s + 0.25).toFixed(2)))}
            className="p-1 rounded hover:bg-surface-2 text-muted"
          >
            <ZoomIn size={16} />
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-auto flex justify-center p-4 bg-surface-2/20 relative">
        {rendering && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface/40">
            <Loader2 className="text-muted animate-spin" size={20} />
          </div>
        )}
        <canvas ref={canvasRef} className="shadow-lg" />
      </div>
    </div>
  )
}
