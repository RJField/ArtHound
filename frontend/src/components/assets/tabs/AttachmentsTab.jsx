import { useMemo } from 'react'
import { assetAttachmentUrl } from '../../../lib/api'
import { formatRawFields } from '../../../lib/fields'
import AttachmentGallery from '../../media/AttachmentGallery'

export default function AttachmentsTab({ asset }) {
  const attachmentGroups = useMemo(() => {
    if (!asset?.rawFields || !asset?.canonicalId) return []
    const proxyUrlFn = (fieldKey, idx) => assetAttachmentUrl(asset.canonicalId, fieldKey, idx)
    return formatRawFields(asset.rawFields, proxyUrlFn).filter(f => f.type === 'attachments')
  }, [asset?.id, asset?.canonicalId])

  if (!attachmentGroups.length) {
    return <p className="text-muted text-xs p-4">No attachments on this asset.</p>
  }

  return (
    <div className="h-full overflow-y-auto p-4 flex flex-col gap-5">
      {attachmentGroups.map((group, i) => (
        <AttachmentGallery key={i} label={group.label} attachments={group.items} />
      ))}
    </div>
  )
}
