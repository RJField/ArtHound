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
