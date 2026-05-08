import { useState } from 'react'
import AttachmentCard from './AttachmentCard'
import MediaLightbox from './MediaLightbox'

export default function AttachmentGallery({ label, attachments = [] }) {
  const [lightboxIndex, setLightboxIndex] = useState(null)

  if (!attachments.length) return null

  return (
    <div className="flex flex-col gap-2">
      {label && (
        <span className="text-muted text-xs font-medium uppercase tracking-wide">{label}</span>
      )}
      <div className="flex flex-wrap gap-2">
        {attachments.map((att, i) => (
          <AttachmentCard
            key={i}
            {...att}
            onClick={() => setLightboxIndex(i)}
          />
        ))}
      </div>
      {lightboxIndex !== null && (
        <MediaLightbox
          items={attachments}
          activeIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => setLightboxIndex(i => Math.max(0, i - 1))}
          onNext={() => setLightboxIndex(i => Math.min(attachments.length - 1, i + 1))}
        />
      )}
    </div>
  )
}
