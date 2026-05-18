import { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch } from '../lib/api'

const SESSION_KEY = 'scenario_session_id'

const POLL_FAST_MS  = 5000
const POLL_SLOW_MS  = 10000
const POLL_FAST_MAX = 30000

const GENERATING_STAGES = new Set(['pending_generation', 'generating'])

export function useScenario() {
  const [sessionId,         setSessionId]         = useState(() => sessionStorage.getItem(SESSION_KEY))
  const [messages,          setMessages]          = useState([])
  const [stage,             setStage]             = useState(null)   // null = no active session
  const [messageCount,      setMessageCount]      = useState(0)
  const [showEscape,        setShowEscape]        = useState(false)
  const [products,          setProducts]          = useState([])
  const [assets,            setAssets]            = useState([])
  const [work,              setWork]              = useState([])
  const [sending,           setSending]           = useState(false)
  const [error,             setError]             = useState(null)
  const [generationMode,    setGenerationMode]    = useState('rule_based')
  const [preflightWarnings, setPreflightWarnings] = useState([])
  const [scenarioCategory,  setScenarioCategory]  = useState(null)
  const [pendingAction,     setPendingAction]     = useState(null)  // { type, scope_changes, description }
  const [applyingAction,    setApplyingAction]    = useState(false)
  const [generationStatus,  setGenerationStatus]  = useState(null)

  const pollRef      = useRef(null)
  const pollStartRef = useRef(null)

  // ── Session storage ───────────────────────────────────────────────────────
  const storeSession = useCallback((id) => {
    sessionStorage.setItem(SESSION_KEY, id)
    setSessionId(id)
  }, [])

  const clearSession = useCallback(() => {
    sessionStorage.removeItem(SESSION_KEY)
    setSessionId(null)
    setMessages([])
    setStage(null)
    setMessageCount(0)
    setShowEscape(false)
    setProducts([])
    setAssets([])
    setWork([])
    setError(null)
    setPreflightWarnings([])
    setScenarioCategory(null)
  }, [])

  // ── Apply /data response ──────────────────────────────────────────────────
  const applyData = useCallback((data) => {
    setStage(data.ai_stage)
    setMessageCount(data.message_count ?? 0)
    setShowEscape(data.show_escape ?? false)
    setProducts(data.products ?? [])
    setAssets(data.assets   ?? [])
    setWork(data.work       ?? [])
    if (data.generation_mode)    setGenerationMode(data.generation_mode)
    if (data.preflight_warnings) setPreflightWarnings(data.preflight_warnings)
    if (data.scenario_category)  setScenarioCategory(data.scenario_category)
    setGenerationStatus(data.generation_status ?? null)
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
    const elapsed  = Date.now() - (pollStartRef.current ?? Date.now())
    const interval = elapsed < POLL_FAST_MAX ? POLL_FAST_MS : POLL_SLOW_MS

    pollRef.current = setTimeout(async () => {
      try {
        const data = await apiFetch(`/api/scenario/${sid}/data`)
        applyData(data)
        if (GENERATING_STAGES.has(data.ai_stage)) {
          schedulePoll(sid)
        } else {
          pollStartRef.current = null
          // Generation just completed — load the pivot message the backend wrote.
          loadMessages(sid)
        }
      } catch {
        schedulePoll(sid)
      }
    }, interval)
  }, [applyData, stopPolling])

  const startPolling = useCallback((sid) => {
    pollStartRef.current = Date.now()
    schedulePoll(sid)
  }, [schedulePoll])

  // ── Load messages ─────────────────────────────────────────────────────────
  const loadMessages = useCallback(async (sid) => {
    try {
      const res = await apiFetch(`/api/scenario/${sid}/messages`)
      setMessages(res.messages ?? [])
    } catch { /* non-fatal */ }
  }, [])

  // ── Resume existing session on mount ──────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return   // No session → wizard handles startup
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
        // Session expired or dismissed — go back to wizard.
        clearSession()
      }
    })()
    return stopPolling
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Called by the wizard when generation is queued ────────────────────────
  const beginGeneration = useCallback((sid) => {
    storeSession(sid)
    setStage('pending_generation')
    startPolling(sid)
  }, [storeSession, startPolling])

  // ── Send a message (discussion phase) ────────────────────────────────────
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
      if (res.action) setPendingAction(res.action)

      if (res.generating) startPolling(sessionId)
    } catch (err) {
      const body = err.body ?? {}
      if (body.ai_stage) setStage(body.ai_stage)
      setError(err.message ?? 'Failed to send message')
    } finally {
      setSending(false)
    }
  }, [sessionId, startPolling])

  // ── Apply a pending action (e.g. regenerate with changed scope) ──────────
  const applyAction = useCallback(async (action) => {
    if (!sessionId || !action) return
    setApplyingAction(true)
    setPendingAction(null)
    setError(null)
    try {
      const res = await apiFetch(`/api/scenario/${sessionId}/regenerate`, {
        method: 'POST',
        body: JSON.stringify({ scope_changes: action.scope_changes }),
      })
      setStage(res.ai_stage)
      // Clear stale scenario data immediately so the viewer shows the spinner.
      setProducts([])
      setAssets([])
      setWork([])
      startPolling(sessionId)
    } catch (err) {
      setError(err.message ?? 'Failed to regenerate')
    } finally {
      setApplyingAction(false)
    }
  }, [sessionId, startPolling])

  const dismissAction = useCallback(() => setPendingAction(null), [])

  // ── Retry after generation failure ────────────────────────────────────────
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

  // ── Dismiss → back to wizard ──────────────────────────────────────────────
  const dismiss = useCallback(async () => {
    if (!sessionId) return
    try {
      await apiFetch(`/api/scenario/${sessionId}`, { method: 'DELETE' })
    } catch { /* best-effort */ }
    clearSession()
  }, [sessionId, clearSession])

  return {
    sessionId,
    messages,
    stage,
    messageCount,
    showEscape,
    products,
    assets,
    work,
    sending,
    error,
    generationMode,
    preflightWarnings,
    scenarioCategory,
    pendingAction,
    applyingAction,
    generationStatus,
    isGenerating: GENERATING_STAGES.has(stage),
    hasData: products.length > 0 || assets.length > 0 || work.length > 0,
    beginGeneration,
    sendMessage,
    applyAction,
    dismissAction,
    retryGeneration,
    dismiss,
  }
}
