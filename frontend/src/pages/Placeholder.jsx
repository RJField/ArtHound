import { useLocation } from 'react-router-dom'
import PageContainer from '../components/PageContainer'
import { PageHeader } from '../components/ui'

export default function Placeholder() {
  const { pathname } = useLocation()
  const name = pathname.replace('/', '').replace(/-/g, ' ')

  return (
    <PageContainer width="md" className="p-8">
      <PageHeader
        title={<span className="capitalize">{name}</span>}
        subtitle="This view is being migrated — coming in Phase 2."
      />
    </PageContainer>
  )
}
