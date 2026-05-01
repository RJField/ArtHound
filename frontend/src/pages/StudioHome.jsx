import { useAuth } from '../contexts/AuthContext'

export default function StudioHome() {
  const { profile } = useAuth()

  return (
    <main className="flex-1 p-8">
      <h1 className="text-foreground text-2xl font-semibold mb-1">
        Welcome{profile?.org ? `, ${profile.org.name}` : ''}
      </h1>
      <p className="text-muted text-sm">Studio dashboard — coming in Phase 2.</p>
    </main>
  )
}
