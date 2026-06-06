import { useLocation } from 'react-router-dom'
import PageContainer from '../components/PageContainer'

export default function Placeholder() {
  const { pathname } = useLocation()
  const name = pathname.replace('/', '').replace(/-/g, ' ')

  return (
    <PageContainer width="md" className="p-8">
      <h1 className="text-foreground text-2xl font-semibold mb-1 capitalize">{name}</h1>
      <p className="text-muted text-sm">This view is being migrated — coming in Phase 2.</p>
    </PageContainer>
  )
}
