import { useMemo } from 'react'
import { Paperclip } from 'lucide-react'
import { assetAttachmentUrl } from '../../../lib/api'
import { formatRawFields } from '../../../lib/fields'
import { EmptyState } from '../../ui'
import AttachmentGallery from '../../media/AttachmentGallery'

export default function AttachmentsTab({ asset }) {
  const attachmentGroups = useMemo(() => {
    if (!asset?.rawFields || !asset?.canonicalId) return []
    const proxyUrlFn = (fieldKey, idx) => assetAttachmentUrl(asset.canonicalId, fieldKey, idx)
    return formatRawFields(asset.rawFields, proxyUrlFn).filter(f => f.type === 'attachments')
  }, [asset?.id, asset?.canonicalId])

  if (!attachmentGroups.length) {
    return <EmptyState icon={Paperclip} title="No attachments on this asset." />
  }

  return (
    <div className="h-full overflow-y-auto p-4 flex flex-col gap-5">
      {attachmentGroups.map((group, i) => (
        <AttachmentGallery key={i} label={group.label} attachments={group.items} />
      ))}
    </div>
  )
}
