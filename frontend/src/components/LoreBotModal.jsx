import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../lib/api'

const WELCOME = {
  role: 'assistant',
  content: "Hi! I'm LoreBot. Select an asset or payload below, then ask me anything about its attachments — design documents, briefs, references, and more.",
}

export default function LoreBotModal({ onClose }) {
  const [items, setItems]                       = useState([])
  const [itemsLoading, setItemsLoading]         = useState(true)
  const [selectedItem, setSelectedItem]         = useState(null)
  const [messages, setMessages]                 = useState([WELCOME])
  // pendingMessages holds the full conversation including the unanswered user turn,
  // so we can replay it after replication without relying on stale closure state.
  const [pendingMessages, setPendingMessages]   = useState(null)
  const [input, setInput]                       = useState('')
  const [thinking, setThinking]                 = useState(false)
  const [replicating, setReplicating]           = useState(false)
  const [needsReplication, setNeedsReplication] = useState(false)
  const [uncopied, setUncopied]                 = useState([])
  const bottomRef = useRef(null)
  const inputRef  = useRef(null)

  useEffect(() => {
    apiFetch('/api/lorebot/items')
      .then(data => { setItems(data); setItemsLoading(false) })
      .catch(() => setItemsLoading(false))
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, thinking, needsReplication, replicating])

  useEffect(() => {
    if (selectedItem) inputRef.current?.focus()
  }, [selectedItem])

  function buildReqBody(msgs) {
    const body = { messages: msgs }
    if (selectedItem?.type === 'asset') body.asset_id = selectedItem.id
    else if (selectedItem?.type === 'dispatch') body.dispatch_id = selectedItem.id
    return body
  }

  async function send() {
    const question = input.trim()
    if (!question || thinking || replicating || !selectedItem) return

    const next = [...messages, { role: 'user', content: question }]
    setMessages(next)
    setInput('')
    setThinking(true)
    setNeedsReplication(false)
    setPendingMessages(null)

    try {
      const res = await apiFetch('/api/lorebot/chat', {
        method: 'POST',
        body: JSON.stringify(buildReqBody(next)),
      })
      if (res.needs_replication) {
        setPendingMessages(next)
        setUncopied(res.uncopied)
        setNeedsReplication(true)
      } else {
        setMessages(m => [...m, { role: 'assistant', content: res.answer }])
      }
    } catch (err) {
      setMessages(m => [...m, { role: 'assistant', content: `Error: ${err.message}` }])
    } finally {
      setThinking(false)
    }
  }

  async function handleReplicate() {
    setNeedsReplication(false)
    setReplicating(true)

    try {
      const body = selectedItem.type === 'asset'
        ? { asset_id: selectedItem.id }
        : { dispatch_id: selectedItem.id }

      await apiFetch('/api/lorebot/replicate', {
        method: 'POST',
        body: JSON.stringify(body),
      })

      // Replay the original question now that attachments are available
      const res = await apiFetch('/api/lorebot/chat', {
        method: 'POST',
        body: JSON.stringify(buildReqBody(pendingMessages)),
      })

      if (res.needs_replication) {
        setMessages(m => [...m, {
          role: 'assistant',
          content: "Some files couldn't be replicated. I'll answer based on what's available.",
        }])
      } else {
        setMessages(m => [...m, { role: 'assistant', content: res.answer }])
      }
    } catch (err) {
      setMessages(m => [...m, { role: 'assistant', content: `Replication failed: ${err.message}` }])
    } finally {
      setReplicating(false)
      setPendingMessages(null)
    }
  }

  function handleSkip() {
    setNeedsReplication(false)
    setPendingMessages(null)
    setMessages(m => [...m, {
      role: 'assistant',
      content: "Skipped. LoreBot can only read files replicated in ArtHound. You can replicate them from the attachment viewer and try again.",
    }])
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  function handleSelectItem(id) {
    const item = items.find(i => i.id === id) || null
    setSelectedItem(item)
    setMessages([WELCOME])
    setNeedsReplication(false)
    setPendingMessages(null)
    setInput('')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:justify-end bg-black/60 sm:p-6"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl flex flex-col w-full sm:w-[440px] h-[82vh] sm:h-[660px]">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-accent text-sm font-semibold">LoreBot</span>
            <span className="text-muted text-xs px-1.5 py-0.5 bg-surface-2 rounded">Haiku · PoC</span>
          </div>
          <button onClick={onClose} className="text-muted hover:text-foreground text-xl cursor-pointer leading-none">×</button>
        </div>

        {/* PoC notice */}
        <div className="px-4 py-2 bg-warning/10 border-b border-warning/20 text-warning text-xs shrink-0">
          ⚠ Proof of concept — powered by Claude Haiku. Do not share confidential data.
        </div>

        {/* Item selector */}
        <div className="px-4 py-2.5 border-b border-border shrink-0">
          {itemsLoading ? (
            <div className="text-xs text-muted py-0.5">Loading assets…</div>
          ) : items.length === 0 ? (
            <div className="text-xs text-muted py-0.5">No assets with attachments found.</div>
          ) : (
            <select
              value={selectedItem?.id || ''}
              onChange={e => handleSelectItem(e.target.value)}
              className="w-full bg-surface-2 border border-border rounded-md px-2 py-1.5 text-xs text-foreground outline-none focus:border-accent"
            >
              <option value="">Select an asset or payload…</option>
              {items.map(item => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
          {messages.map((msg, i) => (
            <div key={i} className={msg.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div
                className={
                  msg.role === 'user'
                    ? 'bg-accent text-white text-sm px-3 py-2 rounded-2xl rounded-tr-sm max-w-[80%]'
                    : 'bg-surface-2 text-foreground text-sm px-3 py-2 rounded-2xl rounded-tl-sm max-w-[80%]'
                }
                style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {thinking && (
            <div className="flex justify-start">
              <div className="bg-surface-2 text-muted text-sm px-3 py-2 rounded-2xl rounded-tl-sm">
                <ThinkingDots />
              </div>
            </div>
          )}

          {needsReplication && !replicating && (
            <ReplicationCard
              uncopied={uncopied}
              onReplicate={handleReplicate}
              onSkip={handleSkip}
            />
          )}

          {replicating && (
            <div className="flex justify-start">
              <div className="bg-surface-2 text-muted text-xs px-3 py-2 rounded-2xl rounded-tl-sm flex items-center gap-2">
                Replicating attachments… <ThinkingDots />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="flex items-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={thinking || replicating || !selectedItem}
            rows={1}
            placeholder={selectedItem ? 'Ask about the attachments…' : 'Select an asset or payload first'}
            className="flex-1 bg-surface-2 border border-border rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-accent resize-none disabled:opacity-50"
            style={{ minHeight: '38px', maxHeight: '120px', overflowY: 'auto' }}
          />
          <button
            onClick={send}
            disabled={thinking || replicating || !input.trim() || !selectedItem}
            className="px-3 py-2 rounded-lg bg-accent text-white text-sm hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 shrink-0"
          >
            Send
          </button>
        </div>

      </div>
    </div>
  )
}

function ReplicationCard({ uncopied, onReplicate, onSkip }) {
  return (
    <div className="flex justify-start">
      <div className="bg-surface-2 border border-warning/30 text-foreground text-sm px-3 py-3 rounded-2xl rounded-tl-sm max-w-[90%]">
        <div className="text-warning text-xs font-medium mb-1">Attachments not yet in ArtHound</div>
        <div className="text-muted text-xs mb-2">
          {uncopied.length} file{uncopied.length !== 1 ? 's' : ''} need to be replicated before LoreBot can read them:
        </div>
        <ul className="text-xs text-muted mb-3 space-y-0.5">
          {uncopied.slice(0, 5).map((a, i) => (
            <li key={i}>• {a.filename}</li>
          ))}
          {uncopied.length > 5 && <li>• …and {uncopied.length - 5} more</li>}
        </ul>
        <div className="flex gap-2">
          <button
            onClick={onReplicate}
            className="px-3 py-1 rounded-md bg-accent text-white text-xs hover:bg-accent-hover transition-colors cursor-pointer"
          >
            Replicate now
          </button>
          <button
            onClick={onSkip}
            className="px-3 py-1 rounded-md bg-surface text-muted text-xs hover:text-foreground border border-border transition-colors cursor-pointer"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  )
}

function ThinkingDots() {
  return (
    <span className="inline-flex gap-1 items-center">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  )
}
