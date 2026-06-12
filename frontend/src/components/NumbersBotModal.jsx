import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../lib/api'
import { Button, Modal, Spinner, Textarea } from './ui'

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
    <Modal
      title={
        <span className="flex items-center gap-2">
          <span className="text-accent">NumberBot</span>
          <span className="w-1.5 h-1.5 rounded-full bg-success" />
        </span>
      }
      onClose={onClose}
      width="max-w-sm"
      className="h-[70vh] sm:h-[600px]"
      bodyClassName="flex flex-col p-0 overflow-hidden"
      footer={
        <div className="flex items-end gap-2 w-full">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={thinking}
            rows={1}
            placeholder="Ask about fields, tables, estimates…"
            className="flex-1 resize-none"
            style={{ minHeight: '38px', maxHeight: '120px', overflowY: 'auto' }}
          />
          <Button
            variant="primary"
            size="lg"
            onClick={send}
            disabled={thinking || !input.trim()}
            className="shrink-0"
          >
            Send
          </Button>
        </div>
      }
    >
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
                  ? 'bg-accent text-white text-sm px-3 py-2 rounded-lg rounded-tr-sm max-w-[80%]'
                  : 'bg-surface-2 text-foreground text-sm px-3 py-2 rounded-lg rounded-tl-sm max-w-[80%]'
              }
              style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {thinking && (
          <div className="flex justify-start">
            <div className="bg-surface-2 text-muted text-sm px-3 py-2 rounded-lg rounded-tl-sm">
              <Spinner size={14} />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </Modal>
  )
}
