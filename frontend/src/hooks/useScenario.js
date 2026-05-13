import { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch } from '../lib/api'

const SESSION_KEY = 'scenario_session_id'

// Polling intervals: 5s for first 30s, then 10s.
const POLL_FAST_MS  = 5000
const POLL_SLOW_MS  = 10000
const POLL_FAST_MAX = 30000

const GENERATING_STAGES = new Set(['pending_generation', 'generating'])

export function useScenario() {
  const [sessionId,    setSessionId]    = useState(() => sessionStorage.getItem(SESSION_KEY))
  const [messages,     setMessages]     = useState([])
  const [stage,        setStage]        = useState('scoping')
  const [messageCount, setMessageCount] = useState(0)
  const [showEscape,   setShowEscape]   = useState(false)
  const [products,     setProducts]     = useState([])
  const [assets,       setAssets]       = useState([])
  const [work,         setWork]         = useState([])
  const [sending,      setSending]      = useState(false)
  const [starting,     setStarting]     = useState(false)
  const [error,        setError]        = useState(null)

  const pollRef       = useRef(null)
  const pollStartRef  = useRef(null)

  // ── Persist session ID to sessionStorage ────────────────────────────────
  const storeSession = useCallback((id) => {
    sessionStorage.setItem(SESSION_KEY, id)
    setSessionId(id)
  }, [])

  const clearSession = useCallback(() => {
    sessionStorage.removeItem(SESSION_KEY)
    setSessionId(null)
    setMessages([])
    setStage('scoping')
    setMessageCount(0)
    setShowEscape(false)
    setProducts([])
    setAssets([])
    setWork([])
    setError(null)
  }, [])

  // ── Apply /data response to state ────────────────────────────────────────
  const applyData = useCallback((data) => {
    setStage(data.ai_stage)
    setMessageCount(data.message_count ?? 0)
    setShowEscape(data.show_escape ?? false)
    setProducts(data.products ?? [])
    setAssets(data.assets   ?? [])
    setWork(data.work       ?? [])
  }, [])

  // ── Polling ───────────────────────────────────────────────────────────────
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const schedulePoll = useCallback((sid) => {
    stopPolling()
    const elapsed = Date.now() - (pollStartRef.current ?? Date.now())
    const interval = elapsed < POLL_FAST_MAX ? POLL_FAST_MS : POLL_SLOW_MS

    pollRef.current = setTimeout(async () => {
      try {
        const data = await apiFetch(`/api/scenario/${sid}/data`)
        applyData(data)
        if (GENERATING_STAGES.has(data.ai_stage)) {
          schedulePoll(sid)
        } else {
          pollStartRef.current = null
        }
      } catch {
        // Network hiccup — keep polling.
        schedulePoll(sid)
      }
    }, interval)
  }, [applyData, stopPolling])

  const startPolling = useCallback((sid) => {
    pollStartRef.current = Date.now()
    schedulePoll(sid)
  }, [schedulePoll])

  // ── Load messages for an existing session ────────────────────────────────
  const loadMessages = useCallback(async (sid) => {
    try {
      const res = await apiFetch(`/api/scenario/${sid}/messages`)
      setMessages(res.messages ?? [])
    } catch {
      // Non-fatal — chat history unavailable.
    }
  }, [])

  // ── Start or resume a session ────────────────────────────────────────────
  const startSession = useCallback(async () => {
    setStarting(true)
    setError(null)
    try {
      const res = await apiFetch('/api/scenario/start', { method: 'POST' })
      storeSession(res.session_id)
      setStage(res.ai_stage)
      setMessageCount(res.message_count ?? 0)

      await loadMessages(res.session_id)

      if (GENERATING_STAGES.has(res.ai_stage)) {
        startPolling(res.session_id)
      }

      // Greet on fresh sessions.
      if (!res.resumed && messages.length === 0) {
        setMessages([{
          role: 'assistant',
          content: "Hi! I'm here to help you plan a production scenario. I'll use your estimation matrix and workflow setup to build something realistic.\n\nTo get started — how far ahead are you planning, and how does content typically release for your studio?",
        }])
      }
    } catch (err) {
      if (err.message?.includes('estimation matrix')) {
        setError('matrix_missing')
      } else {
        setError(err.message ?? 'Failed to start scenario')
      }
    } finally {
      setStarting(false)
    }
  }, [storeSession, loadMessages, startPolling, messages.length])

  // ── Auto-start on mount if no session ────────────────────────────────────
  useEffect(() => {
    if (!sessionId) {
      startSession()
    } else {
      // Resume: load data + messages for existing session.
      ;(async () => {
        try {
          const [data] = await Promise.all([
            apiFetch(`/api/scenario/${sessionId}/data`),
            loadMessages(sessionId),
          ])
          applyData(data)
          if (GENERATING_STAGES.has(data.ai_stage)) {
            startPolling(sessionId)
          }
        } catch {
          // Session may have expired — clear and restart.
          clearSession()
          startSession()
        }
      })()
    }
    return stopPolling
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Send a message ────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (content) => {
    if (!sessionId || !content.trim()) return
    setSending(true)
    setError(null)

    const userMsg = { role: 'user', content }
    setMessages(prev => [...prev, userMsg])

    try {
      const res = await apiFetch(`/api/scenario/${sessionId}/message`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      })
      setMessages(prev => [...prev, { role: 'assistant', content: res.message }])
      setStage(res.ai_stage)
      setShowEscape(res.show_escape ?? false)

      if (res.generating) {
        startPolling(sessionId)
      }
    } catch (err) {
      // 409 carries ai_stage — update state without rolling back user message.
      const body = err.body ?? {}
      if (body.ai_stage) setStage(body.ai_stage)
      setError(err.message ?? 'Failed to send message')
    } finally {
      setSending(false)
    }
  }, [sessionId, startPolling])

  // ── Force generate (escape hatch) ────────────────────────────────────────
  const forceGenerate = useCallback(async () => {
    if (!sessionId) return
    try {
      const res = await apiFetch(`/api/scenario/${sessionId}/force-generate`, { method: 'POST' })
      setStage(res.ai_stage)
      startPolling(sessionId)
    } catch (err) {
      setError(err.message ?? 'Failed to start generation')
    }
  }, [sessionId, startPolling])

  // ── Retry after generation failure ───────────────────────────────────────
  const retryGeneration = useCallback(async () => {
    if (!sessionId) return
    try {
      const res = await apiFetch(`/api/scenario/${sessionId}/retry-generation`, { method: 'POST' })
      setStage(res.ai_stage)
      startPolling(sessionId)
    } catch (err) {
      setError(err.message ?? 'Failed to retry generation')
    }
  }, [sessionId, startPolling])

  // ── Dismiss session ───────────────────────────────────────────────────────
  const dismiss = useCallback(async () => {
    if (!sessionId) return
    try {
      await apiFetch(`/api/scenario/${sessionId}`, { method: 'DELETE' })
    } catch {
      // Best-effort.
    }
    clearSession()
    startSession()
  }, [sessionId, clearSession, startSession])

  return {
    // State
    sessionId,
    messages,
    stage,
    messageCount,
    showEscape,
    products,
    assets,
    work,
    sending,
    starting,
    error,
    // Derived
    isGenerating: GENERATING_STAGES.has(stage),
    hasData: products.length > 0 || assets.length > 0 || work.length > 0,
    // Actions
    sendMessage,
    forceGenerate,
    retryGeneration,
    dismiss,
  }
}
