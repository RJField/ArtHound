import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '../../lib/api'
import { Button, Field, Input, Modal, Select, Spinner } from '../ui'

// Studio-side editor for the link's review protocol (required submissions, req 1).
// Pick/create an org protocol, edit its ordered step list, assign it to this link.
// Steps removed here are archived server-side — reviews already tagged keep their link.
export default function ProtocolModal({ link, onClose, onSaved }) {
  const [protocols, setProtocols]   = useState(null)
  const [selectedId, setSelectedId] = useState(link.review_protocol_def_id || '')
  const [steps, setSteps]           = useState([])   // ordered buffer for the selected protocol
  const [newName, setNewName]       = useState('')
  const [saving, setSaving]         = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    apiFetch('/api/reviews/protocols', { signal: controller.signal })
      .then(data => {
        setProtocols(data ?? [])
        const current = (data ?? []).find(p => p.id === (link.review_protocol_def_id || ''))
        if (current) setSteps(current.steps.map(s => ({ ...s })))
      })
      .catch(err => { if (err.name !== 'AbortError') { toast.error(err.message); setProtocols([]) } })
    return () => controller.abort()
  }, [link.review_protocol_def_id])

  function selectProtocol(id) {
    setSelectedId(id)
    const p = protocols?.find(x => x.id === id)
    setSteps(p ? p.steps.map(s => ({ ...s })) : [])
  }

  async function seedDefault() {
    try {
      const p = await apiFetch('/api/reviews/protocols/seed-default', { method: 'POST' })
      setProtocols(prev => [...(prev ?? []), p])
      setSelectedId(p.id)
      setSteps(p.steps.map(s => ({ ...s })))
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function createProtocol() {
    const name = newName.trim()
    if (!name) return
    try {
      const p = await apiFetch('/api/reviews/protocols', {
        method: 'POST',
        body: JSON.stringify({ name, steps: [] }),
      })
      setProtocols(prev => [...(prev ?? []), p])
      setSelectedId(p.id)
      setSteps([])
      setNewName('')
    } catch (err) {
      toast.error(err.message)
    }
  }

  function moveStep(i, dir) {
    setSteps(prev => {
      const next = [...prev]
      const j = i + dir
      if (j < 0 || j >= next.length) return prev
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  async function save() {
    setSaving(true)
    try {
      if (selectedId) {
        if (steps.some(s => !s.name.trim())) {
          toast.error('Every step needs a name')
          return
        }
        await apiFetch(`/api/reviews/protocols/${selectedId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            steps: steps.map(s => ({ id: s.id || null, name: s.name, description: s.description || null })),
          }),
        })
      }
      if (selectedId !== (link.review_protocol_def_id || '')) {
        await apiFetch(`/api/reviews/links/${link.id}/protocol`, {
          method: 'POST',
          body: JSON.stringify({ protocol_def_id: selectedId || null }),
        })
      }
      toast.success('Review protocol saved')
      onSaved()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Review Protocol"
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="lg" onClick={save} disabled={saving || protocols === null}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {protocols === null ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-muted text-xs">
            Required submissions for this connection. The vendor sees each step as a checklist
            item per shared asset and fulfils it by submitting a cross-org review.
          </p>

          <Field label="Protocol for this connection">
            <Select size="lg" value={selectedId} onChange={e => selectProtocol(e.target.value)}>
              <option value="">None — no required submissions</option>
              {protocols.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>

          {protocols.length === 0 && (
            <Button size="sm" onClick={seedDefault} className="self-start">
              Start from default (Delivery Review)
            </Button>
          )}

          <Field label="Create new protocol">
            <div className="flex gap-2">
              <Input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Protocol name…"
                className="flex-1"
              />
              <Button size="sm" onClick={createProtocol} disabled={!newName.trim()}>Create</Button>
            </div>
          </Field>

          {selectedId && (
            <Field label="Required submissions (ordered)">
              <div className="flex flex-col gap-1.5">
                {steps.length === 0 && (
                  <p className="text-faint text-xs py-1">No steps yet — add the first one below.</p>
                )}
                {steps.map((s, i) => (
                  <div key={s.id || `new-${i}`} className="flex items-center gap-1.5">
                    <span className="text-faint text-xs w-4 text-right shrink-0 tabular-nums">{i + 1}.</span>
                    <Input
                      type="text"
                      value={s.name}
                      onChange={e => setSteps(prev => prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                      placeholder="Step name…"
                      className="flex-1"
                    />
                    <Button variant="ghost" size="sm" className="px-1" onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label="Move up">
                      <ArrowUp size={12} />
                    </Button>
                    <Button variant="ghost" size="sm" className="px-1" onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} aria-label="Move down">
                      <ArrowDown size={12} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="px-1 hover:text-error"
                      onClick={() => setSteps(prev => prev.filter((_, j) => j !== i))}
                      aria-label="Remove step"
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => setSteps(prev => [...prev, { name: '', description: null }])}
                >
                  <Plus size={12} /> Add step
                </Button>
              </div>
            </Field>
          )}
        </div>
      )}
    </Modal>
  )
}
