import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../lib/api'

const WELCOME = {
  role: 'assistant',
  content: "Hi! I'm NumberBot. Ask me anything about the ArtHound asset schema — fields, types, tables, and how they relate to estimation and production.",
}

export default function NumbersBotModal({ onClose }) {
  const [messages, setMessages] = useState([WELCOME])
  const [input, setInput]       = useState('')
  const [thinking, setThinking] = useState(false)
  const bottomRef               = useRef(null)
  const inputRef                = useRef(null)

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, thinking])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function send() {
    const question = input.trim()
    if (!question || thinking) return

    const next = [...messages, { role: 'user', content: question }]
    setMessages(next)
    setInput('')
    setThinking(true)

    try {
      const { answer } = await apiFetch('/api/numbersbot/chat', {
        method: 'POST',
        body: JSON.stringify({ messages: next }),
      })
      setMessages(m => [...m, { role: 'assistant', content: answer }])
    } catch (err) {
      setMessages(m => [...m, { role: 'assistant', content: `Error: ${err.message}` }])
    } finally {
      setThinking(false)
      inputRef.current?.focus()
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:justify-end bg-black/60 sm:p-6"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl flex flex-col w-full sm:w-96 h-[70vh] sm:h-[600px]">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-accent text-sm font-semibold">NumberBot</span>
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
          </div>
          <button onClick={onClose} className="text-muted hover:text-foreground text-xl cursor-pointer leading-none">×</button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={msg.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
            >
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

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="flex items-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={thinking}
            rows={1}
            placeholder="Ask about fields, tables, estimates…"
            className="flex-1 bg-surface-2 border border-border rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-accent resize-none disabled:opacity-50"
            style={{ minHeight: '38px', maxHeight: '120px', overflowY: 'auto' }}
          />
          <button
            onClick={send}
            disabled={thinking || !input.trim()}
            className="px-3 py-2 rounded-lg bg-accent text-white text-sm hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 shrink-0"
          >
            Send
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
