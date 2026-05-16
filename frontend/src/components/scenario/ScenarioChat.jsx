import { useEffect, useRef, useState } from 'react'

const STAGE_LABELS = {
  scoping:            null,
  pending_generation: 'Queued — waiting for generation to start…',
  generating:         'Generating scenario…',
  generation_failed:  null,
  discussion:         null,
}

export default function ScenarioChat({
  messages,
  stage,
  showEscape,
  sending,
  isGenerating,
  error,
  onSend,
  onForceGenerate,
  onRetry,
  pendingAction,
  onApplyAction,
  onDismissAction,
  applyingAction,
}) {
  const [input, setInput] = useState('')
  const bottomRef = useRef(null)
  const inputRef  = useRef(null)

  // Auto-scroll to latest message.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isGenerating, stage])

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!input.trim() || sending || isGenerating) return
    onSend(input.trim())
    setInput('')
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  const inputDisabled = sending || isGenerating || stage === 'generation_failed'
  const statusLabel   = STAGE_LABELS[stage]

  return (
    <div className="flex flex-col border-b border-border" style={{ height: '38vh', minHeight: 220 }}>
      {/* Message thread */}
      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-3">
        {messages.map((msg, i) => (
          <MessageBubble key={i} role={msg.role} content={msg.content} />
        ))}

        {/* Generation status */}
        {statusLabel && (
          <div className="flex items-center gap-2 text-muted text-sm py-1">
            <Spinner />
            <span>{statusLabel}</span>
          </div>
        )}

        {/* Generation failed */}
        {stage === 'generation_failed' && (
          <div className="flex items-center gap-3 bg-surface-2 border border-border rounded-lg px-4 py-3 text-sm">
            <span className="text-foreground">Generation failed — something went wrong.</span>
            <button
              onClick={onRetry}
              className="text-accent hover:text-accent/80 font-medium transition-colors"
            >
              Try again
            </button>
          </div>
        )}

        {/* Pending action card — sits after the last message */}
        {pendingAction && pendingAction.type === 'regenerate' && (
          <ActionCard
            action={pendingAction}
            applying={applyingAction}
            onApply={() => onApplyAction(pendingAction)}
            onDismiss={onDismissAction}
          />
        )}

        <div ref={bottomRef} />
      </div>

      {/* Escape hatch */}
      {showEscape && stage === 'scoping' && (
        <div className="px-6 pb-2">
          <button
            onClick={onForceGenerate}
            className="text-xs text-muted hover:text-foreground transition-colors border border-border rounded px-3 py-1"
          >
            Generate with what I have →
          </button>
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSubmit} className="flex gap-2 px-6 py-3 border-t border-border">
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={inputDisabled}
          placeholder={
            isGenerating ? 'Generating scenario…' :
            stage === 'generation_failed' ? 'Generation failed — use retry above' :
            stage === 'discussion' ? 'Ask anything about the scenario…' :
            'Describe your production plans…'
          }
          rows={2}
          className="flex-1 resize-none bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50 disabled:opacity-40 transition-colors"
        />
        <button
          type="submit"
          disabled={inputDisabled || !input.trim()}
          className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors self-end"
        >
          Send
        </button>
      </form>
    </div>
  )
}

function MessageBubble({ role, content }) {
  const isUser = role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? 'bg-accent text-white rounded-br-sm'
            : 'bg-surface-2 text-foreground border border-border rounded-bl-sm'
        }`}
      >
        {content}
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-3.5 w-3.5 text-muted"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  )
}

function ActionCard({ action, applying, onApply, onDismiss }) {
  const changes = action.scope_changes || {}
  const lines = []

  if (changes.craft_caps) {
    for (const [craft, cap] of Object.entries(changes.craft_caps)) {
      lines.push(cap === null ? `Remove cap on ${craft}` : `${craft} cap → ${cap}`)
    }
  }
  if (changes.release_interval_days != null) {
    lines.push(`Cadence → ${changes.release_interval_days} days between releases`)
  }
  if (changes.num_products != null) {
    lines.push(`${changes.num_products} products/sprints`)
  }
  if (changes.scale) {
    for (const [profile, count] of Object.entries(changes.scale)) {
      lines.push(`${profile}: ${count} assets`)
    }
  }

  return (
    <div className="rounded-xl border border-accent/40 bg-surface-2 px-4 py-3 flex flex-col gap-2.5 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-foreground font-medium text-xs mb-1">Proposed changes</p>
          <p className="text-muted text-xs leading-relaxed">{action.description}</p>
        </div>
      </div>
      {lines.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {lines.map((l, i) => (
            <li key={i} className="text-xs text-foreground font-mono bg-surface rounded px-2 py-0.5">
              {l}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2 pt-0.5">
        <button
          onClick={onApply}
          disabled={applying}
          className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-40 transition-colors"
        >
          {applying ? 'Regenerating…' : 'Apply & Regenerate'}
        </button>
        <button
          onClick={onDismiss}
          disabled={applying}
          className="px-3 py-1.5 rounded-md text-muted text-xs hover:text-foreground transition-colors"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
