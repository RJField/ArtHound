import { useEffect, useRef, useState } from 'react'
import { Button, Pill, Spinner, Textarea } from '../ui'

const STAGE_STATUS = {
  scoping:            null,
  pending_generation: { label: 'Queued — waiting for generation to start…', tone: 'warning' },
  generating:         { label: 'Generating scenario…', tone: 'info' },
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
  const scrollRef = useRef(null)
  const inputRef  = useRef(null)

  // Scroll the chat container (not the page) to the bottom on new messages.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, isGenerating, stage, error])

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
  const stageStatus   = STAGE_STATUS[stage]

  return (
    <div className="flex flex-col border-b border-border" style={{ height: '38vh', minHeight: 220 }}>
      {/* Message thread */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-3">
        {messages.map((msg, i) => (
          <MessageBubble key={i} role={msg.role} content={msg.content} />
        ))}

        {/* Generation status */}
        {stageStatus && (
          <div className="flex items-center gap-2 py-1">
            <Spinner size={14} />
            <Pill tone={stageStatus.tone}>{stageStatus.label}</Pill>
          </div>
        )}

        {/* Generation failed */}
        {stage === 'generation_failed' && (
          <div className="flex items-center gap-3 bg-error-tint border border-error/25 rounded-lg px-4 py-3 text-sm">
            <Pill tone="error">Failed</Pill>
            <span className="text-foreground">Generation failed — something went wrong.</span>
            <Button size="sm" variant="primary" onClick={onRetry}>
              Try again
            </Button>
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

        {/* Send error (e.g. overloaded) */}
        {error && (
          <div className="text-sm text-error bg-error-tint border border-error/25 rounded-lg px-4 py-2">
            {error}
          </div>
        )}

        <div />
      </div>

      {/* Escape hatch */}
      {showEscape && stage === 'scoping' && (
        <div className="px-6 pb-2">
          <Button size="sm" onClick={onForceGenerate}>
            Generate with what I have →
          </Button>
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSubmit} className="flex gap-2 px-6 py-3 border-t border-border">
        <Textarea
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
          className="flex-1 resize-none"
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={inputDisabled || !input.trim()}
          className="self-end"
        >
          Send
        </Button>
      </form>
    </div>
  )
}

function MessageBubble({ role, content }) {
  const isUser = role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
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
    <div className="rounded-lg border border-accent/40 bg-surface-2 px-4 py-3 flex flex-col gap-2.5 text-sm">
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
        <Button variant="primary" onClick={onApply} disabled={applying}>
          {applying ? 'Regenerating…' : 'Apply & Regenerate'}
        </Button>
        <Button variant="ghost" onClick={onDismiss} disabled={applying}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}
