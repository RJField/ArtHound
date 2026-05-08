const EXT_MAP = {
  pdf:  'application/pdf',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  gif:  'image/gif',
  webp: 'image/webp',
  svg:  'image/svg+xml',
  mp4:  'video/mp4',
  mov:  'video/quicktime',
  webm: 'video/webm',
  avi:  'video/x-msvideo',
  mkv:  'video/x-matroska',
}

export function resolveMimetype(mimetype, filename) {
  if (mimetype) return mimetype
  const ext = filename?.split('.').pop()?.toLowerCase()
  return EXT_MAP[ext] ?? null
}

export function viewerType(mimetype, filename) {
  const mt = resolveMimetype(mimetype, filename)
  if (!mt) return 'document'
  if (mt.startsWith('image/')) return 'image'
  if (mt.startsWith('video/')) return 'video'
  if (mt === 'application/pdf') return 'pdf'
  return 'document'
}
