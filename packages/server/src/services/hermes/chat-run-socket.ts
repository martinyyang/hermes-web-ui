/**
 * Chat run via Socket.IO — namespace /chat-run.
 *
 * Replaces HTTP POST + SSE. Socket.IO decouples message handling
 * from connection lifecycle: the server continues streaming upstream
 * events even after the client disconnects or refreshes.
 *
 * Uses Socket.IO rooms keyed by session_id. On client reconnect,
 * the client emits 'resume' to rejoin its session room.
 */
import type { Server, Socket } from 'socket.io'
import { EventSource } from 'eventsource'
import { setRunSession } from '../../routes/hermes/proxy-handler'
import { updateUsage } from '../../db/hermes/usage-store'
import { getSessionDetailFromDb } from '../../db/hermes/sessions-db'
import { getModelContextLength } from './model-context'
import { ChatContextCompressor, countTokens, SUMMARY_PREFIX } from '../../lib/context-compressor'
import { getCompressionSnapshot } from '../../db/hermes/compression-snapshot'
import { logger } from '../logger'

const compressor = new ChatContextCompressor()

// --- Session state tracking ---

interface SessionMessage {
  id: number | string
  session_id: string
  role: string
  content: string
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  timestamp: number
  reasoning?: string | null
}

interface SessionState {
  messages: SessionMessage[]
  isWorking: boolean
  events: Array<{ event: string; data: any }>
  abortController?: AbortController
  runId?: string
  inputTokens?: number
  outputTokens?: number
}

// --- ChatRunSocket ---

export class ChatRunSocket {
  private nsp: ReturnType<Server['of']>
  private gatewayManager: any
  /** sessionId → session state (messages, working status, events, run tracking) */
  private sessionMap = new Map<string, SessionState>()

  constructor(io: Server, gatewayManager: any) {
    this.nsp = io.of('/chat-run')
    this.gatewayManager = gatewayManager
  }

  init() {
    this.nsp.use(this.authMiddleware.bind(this))
    this.nsp.on('connection', this.onConnection.bind(this))
    logger.info('[chat-run-socket] Socket.IO ready at /chat-run')
  }

  // --- Auth middleware ---

  private async authMiddleware(socket: Socket, next: (err?: Error) => void) {
    const token = socket.handshake.auth?.token as string | undefined
    if (!process.env.AUTH_DISABLED && process.env.AUTH_DISABLED !== '1') {
      const { getToken } = await import('../auth')
      const serverToken = await getToken()
      if (serverToken && token !== serverToken) {
        return next(new Error('Authentication failed'))
      }
    }
    next()
  }

  // --- Connection handler ---

  private onConnection(socket: Socket) {
    const profile = (socket.handshake.query?.profile as string) || 'default'

    socket.on('run', async (data: {
      input: string
      session_id?: string
      model?: string
      instructions?: string
    }) => {
      await this.handleRun(socket, data, profile)
    })

    socket.on('resume', async (data: { session_id?: string }) => {
      if (!data.session_id) return
      const sid = data.session_id
      const room = `session:${sid}`
      socket.join(room)

      let state = this.sessionMap.get(sid)

      // Not in memory — load from DB
      if (!state) {
        try {
          const detail = await getSessionDetailFromDb(sid)
          const messages = detail?.messages?.length
            ? detail.messages
                .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') && m.content !== undefined)
                .map(m => {
                  const msg: any = {
                    id: m.id,
                    session_id: sid,
                    role: m.role,
                    content: m.content || '',
                    timestamp: m.timestamp,
                  }
                  if (m.tool_calls?.length) msg.tool_calls = m.tool_calls
                  if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
                  if (m.tool_name) msg.tool_name = m.tool_name
                  if (m.reasoning) msg.reasoning = m.reasoning
                  return msg
                })
            : []

          // Calculate context tokens — aware of compression snapshot
          let inputTokens: number
          const snapshot = getCompressionSnapshot(sid)
          if (snapshot) {
            const newMessages = messages.slice(snapshot.lastMessageIndex + 1)
            inputTokens = countTokens(SUMMARY_PREFIX + snapshot.summary) +
              newMessages.reduce((sum, m) => sum + countTokens(m.content || ''), 0)
          } else {
            inputTokens = messages.reduce((sum, m) => sum + countTokens(m.content || ''), 0)
          }
          const outputTokens = messages
            .filter(m => m.role === 'assistant')
            .reduce((sum, m) => sum + countTokens(m.content || ''), 0)
          state = {
            messages,
            isWorking: false,
            events: [],
            inputTokens,
            outputTokens,
          }
          this.sessionMap.set(sid, state)
          logger.info('[chat-run-socket] loaded session %s from DB (%d messages)', sid, messages.length)
        } catch (err) {
          logger.warn(err, '[chat-run-socket] failed to load session %s from DB on resume', sid)
          state = { messages: [], isWorking: false, events: [] }
          this.sessionMap.set(sid, state)
        }
      }

      // Reply with messages, working status + events (if working)
      socket.emit('resumed', {
        session_id: sid,
        messages: state.messages,
        isWorking: state.isWorking,
        events: state.isWorking ? state.events : [],
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
      })

      logger.info('[chat-run-socket] socket %s resumed session %s (working: %s, messages: %d)',
        socket.id, sid, state.isWorking, state.messages.length)
    })

    socket.on('abort', (data: { session_id?: string }) => {
      if (data.session_id) {
        this.handleAbort(data.session_id)
      }
    })
  }

  // --- Run handler ---

  private async handleRun(
    socket: Socket,
    data: { input: string; session_id?: string; model?: string; instructions?: string },
    profile: string,
  ) {
    const { input, session_id, model, instructions } = data
    const upstream = (process.env.UPSTREAM || 'http://127.0.0.1:8642').replace(/\/$/, '')
    const apiKey = this.gatewayManager.getApiKey(profile) || undefined

    // Mark working immediately on run start, and append user message
    if (session_id) {
      const state = this.getOrCreateSession(session_id)
      state.isWorking = true
      state.messages.push({
        id: state.messages.length + 1,
        session_id,
        role: 'user',
        content: input,
        timestamp: Math.floor(Date.now() / 1000),
      })
      socket.join(`session:${session_id}`)
    }

    // Emit helper: tag every payload with session_id
    const emit = (event: string, payload: any) => {
      const tagged = session_id ? { ...payload, session_id } : payload
      if (session_id) {
        this.nsp.to(`session:${session_id}`).emit(event, tagged)
      } else if (socket.connected) {
        socket.emit(event, tagged)
      }
    }

    try {
      // Build upstream request body
      const body: Record<string, any> = { input }
      if (session_id) body.session_id = session_id
      if (model) body.model = model
      if (instructions) body.instructions = instructions

      // Build conversation_history from DB if session_id is provided
      if (session_id) {
        try {
          const detail = await getSessionDetailFromDb(session_id)
          if (detail?.messages?.length) {
            let history: Array<{
              role: string
              content: string
              tool_calls?: any[]
              tool_call_id?: string
              name?: string
            }> = detail.messages
              .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') && m.content !== undefined)
              .map(m => {
                const msg: any = { role: m.role, content: m.content || '' }
                if (m.tool_calls?.length) msg.tool_calls = m.tool_calls
                if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
                if (m.tool_name) msg.name = m.tool_name
                return msg
              })

            // Context compression with snapshot awareness
            const contextLength = getModelContextLength(profile)
            const triggerTokens = Math.floor(contextLength / 2)

            // Step 1: Check existing snapshot — if present, assemble summary + new messages
            const snapshot = session_id ? getCompressionSnapshot(session_id) : null
            if (snapshot) {
              const newMessages = history.slice(snapshot.lastMessageIndex + 1)
              const summaryTokens = countTokens(SUMMARY_PREFIX + snapshot.summary)
              const newTokens = newMessages.reduce((sum, m) => sum + countTokens(m.content), 0)
              const assembledTokens = summaryTokens + newTokens
              logger.info('[context-compress] session=%s: snapshot at %d, %d new messages, assembled ~%d tokens (threshold %d)',
                session_id, snapshot.lastMessageIndex, newMessages.length, assembledTokens, triggerTokens)
              if (assembledTokens <= triggerTokens) {
                // Under threshold — use assembled context directly, no LLM call needed
                history = [
                  { role: 'user', content: SUMMARY_PREFIX + '\n\n' + snapshot.summary },
                  ...newMessages,
                ]
              } else {
                // Over threshold — needs incremental LLM compression
                const beforeTokens = assembledTokens
                this.pushState(session_id, 'compression.started', {
                  event: 'compression.started',
                  message_count: newMessages.length,
                  token_count: beforeTokens,
                })
                emit('compression.started', {
                  event: 'compression.started',
                  message_count: newMessages.length,
                  token_count: beforeTokens,
                })

                try {
                  const result = await compressor.compress(
                    history, upstream, apiKey, session_id, contextLength,
                  )

                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens,
                    afterTokens: result.messages.reduce((sum, m) => sum + countTokens(m.content), 0),
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })
                  logger.info('[context-compress] AFTER  session=%s: %d messages, ~%d tokens (was %d)', session_id, result.messages.length, result.messages.reduce((sum, m) => sum + countTokens(m.content), 0), beforeTokens)

                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens,
                    afterTokens: result.messages.reduce((sum, m) => sum + countTokens(m.content), 0),
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })

                  history = result.messages.map(m => ({
                    role: m.role,
                    content: m.content,
                    tool_calls: m.tool_calls,
                    tool_call_id: m.tool_call_id,
                    name: m.name,
                  }))
                } catch (err: any) {
                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: newMessages.length,
                    resultMessages: newMessages.length,
                    beforeTokens,
                    afterTokens: beforeTokens,
                    summaryTokens: 0,
                    verbatimCount: newMessages.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                  logger.warn(err, '[chat-run-socket] compression failed for session %s, using assembled context', session_id)
                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: newMessages.length,
                    resultMessages: newMessages.length,
                    beforeTokens,
                    afterTokens: beforeTokens,
                    summaryTokens: 0,
                    verbatimCount: newMessages.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                }
              }
            } else if (history.length > 4) {
              // No snapshot — check if raw history exceeds threshold
              const beforeTokens = history.reduce((sum, m) => sum + countTokens(m.content), 0)

              if (beforeTokens <= triggerTokens) {
                // Under threshold — use raw history as-is
                logger.info('[context-compress] session=%s: %d messages, ~%d tokens — under threshold, skip', session_id, history.length, beforeTokens)
              } else {
                // Over threshold — full LLM compression
                logger.info('[context-compress] BEFORE session=%s: %d messages, ~%d tokens (threshold %d)', session_id, history.length, beforeTokens, triggerTokens)

                this.pushState(session_id, 'compression.started', {
                  event: 'compression.started',
                  message_count: history.length,
                  token_count: beforeTokens,
                })
                emit('compression.started', {
                  event: 'compression.started',
                  message_count: history.length,
                  token_count: beforeTokens,
                })

                try {
                  const result = await compressor.compress(
                    history, upstream, apiKey, session_id, contextLength,
                  )

                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens,
                    afterTokens: result.messages.reduce((sum, m) => sum + countTokens(m.content), 0),
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })
                  logger.info('[context-compress] AFTER  session=%s: %d messages, ~%d tokens (was %d)', session_id, result.messages.length, result.messages.reduce((sum, m) => sum + countTokens(m.content), 0), beforeTokens)

                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens,
                    afterTokens: result.messages.reduce((sum, m) => sum + countTokens(m.content), 0),
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })

                  history = result.messages.map(m => ({
                    role: m.role,
                    content: m.content,
                    tool_calls: m.tool_calls,
                    tool_call_id: m.tool_call_id,
                    name: m.name,
                  }))
                } catch (err: any) {
                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: history.length,
                    resultMessages: history.length,
                    beforeTokens,
                    afterTokens: beforeTokens,
                    summaryTokens: 0,
                    verbatimCount: history.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                  logger.warn(err, '[chat-run-socket] compression failed for session %s, using raw history', session_id)
                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: history.length,
                    resultMessages: history.length,
                    beforeTokens,
                    afterTokens: beforeTokens,
                    summaryTokens: 0,
                    verbatimCount: history.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                }
              }
            }

            body.conversation_history = history
          }
        } catch (err) {
          logger.warn(err, '[chat-run-socket] failed to load conversation history for session %s', session_id)
        }
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

      const res = await fetch(`${upstream}/v1/runs`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        emit('run.failed', { event: 'run.failed', error: `Upstream ${res.status}: ${text}` })
        return
      }

      const runData = await res.json() as any
      const runId = runData.run_id
      if (!runId) {
        emit('run.failed', { event: 'run.failed', error: 'No run_id in upstream response' })
        return
      }

      if (session_id) {
        setRunSession(runId, session_id)
      }

      const abortController = new AbortController()
      if (session_id) {
        const state = this.getOrCreateSession(session_id)
        state.isWorking = true
        state.runId = runId
        state.abortController = abortController
      }

      emit('run.started', { event: 'run.started', run_id: runId, status: runData.status })

      // Stream upstream events via EventSource — survives socket disconnect
      const eventsUrl = new URL(`${upstream}/v1/runs/${runId}/events`)
      if (apiKey) eventsUrl.searchParams.set('token', apiKey)

      const source = new EventSource(eventsUrl.toString())

      source.onmessage = (event: MessageEvent) => {
        try {
          const parsed = JSON.parse(event.data as string)

          // Track messages into sessionMap
          if (session_id) {
            const state = this.sessionMap.get(session_id)
            if (state) {
              const msgs = state.messages
              const last = msgs[msgs.length - 1]

              switch (parsed.event) {
                case 'message.delta': {
                  if (last?.role === 'assistant') {
                    last.content += (parsed.delta || '')
                  } else {
                    msgs.push({
                      id: msgs.length + 1,
                      session_id,
                      role: 'assistant',
                      content: parsed.delta || '',
                      timestamp: Math.floor(Date.now() / 1000),
                    })
                  }
                  break
                }
                case 'reasoning.delta':
                case 'thinking.delta': {
                  const text = parsed.text || parsed.delta || ''
                  if (!text) break
                  if (last?.role === 'assistant') {
                    last.reasoning = (last.reasoning || '') + text
                  } else {
                    msgs.push({
                      id: msgs.length + 1,
                      session_id,
                      role: 'assistant',
                      content: '',
                      reasoning: text,
                      timestamp: Math.floor(Date.now() / 1000),
                    })
                  }
                  break
                }
                case 'tool.started': {
                  msgs.push({
                    id: msgs.length + 1,
                    session_id,
                    role: 'tool',
                    content: '',
                    tool_name: parsed.tool || parsed.name || null,
                    timestamp: Math.floor(Date.now() / 1000),
                  })
                  break
                }
                case 'tool.completed': {
                  const toolMsg = [...msgs].reverse().find(m => m.role === 'tool')
                  if (toolMsg) {
                    // tool_name already set by tool.started
                  }
                  break
                }
                case 'run.completed': {
                  // Finalize assistant message — if no content was streamed, use output
                  if (parsed.output && !runProducedAssistantText(msgs)) {
                    if (last?.role === 'assistant') {
                      last.content = parsed.output
                    } else {
                      msgs.push({
                        id: msgs.length + 1,
                        session_id,
                        role: 'assistant',
                        content: parsed.output,
                        timestamp: Math.floor(Date.now() / 1000),
                      })
                    }
                  }
                  break
                }
              }
            }
          }

          // Track usage — self-calculate with countTokens + snapshot
          if (parsed.event === 'run.completed') {
            const sid = session_id
            if (sid) {
              const state = this.sessionMap.get(sid)
              if (state) {
                const snapshot = getCompressionSnapshot(sid)
                let inputTokens: number
                if (snapshot) {
                  const newMessages = state.messages.slice(snapshot.lastMessageIndex + 1)
                  inputTokens = countTokens(SUMMARY_PREFIX + snapshot.summary) +
                    newMessages.reduce((sum, m) => sum + countTokens(m.content || ''), 0)
                } else {
                  inputTokens = state.messages.reduce((sum, m) => sum + countTokens(m.content || ''), 0)
                }
                const outputTokens = state.messages
                  .filter(m => m.role === 'assistant')
                  .reduce((sum, m) => sum + countTokens(m.content || ''), 0)
                state.inputTokens = inputTokens
                state.outputTokens = outputTokens
                updateUsage(sid, inputTokens, outputTokens)
                // Emit updated usage to all clients in the room
                emit('usage.updated', {
                  event: 'usage.updated',
                  session_id: sid,
                  inputTokens,
                  outputTokens,
                })
              }
            }
          }

          emit(parsed.event || 'message', parsed)

          if (parsed.event === 'run.completed' || parsed.event === 'run.failed') {
            source.close()
            if (session_id) this.markCompleted(session_id, { event: parsed.event, run_id: parsed.run_id })
          }
        } catch { /* not JSON, skip */ }
      }

      source.onerror = () => {
        source.close()
        emit('run.failed', { event: 'run.failed', error: 'EventSource connection lost' })
        if (session_id) this.markCompleted(session_id, { event: 'run.failed' })
      }
    } catch (err: any) {
      emit('run.failed', { event: 'run.failed', error: err.message })
      if (session_id) this.markCompleted(session_id, { event: 'run.failed' })
    }
  }

  // --- Abort handler ---

  private handleAbort(sessionId: string) {
    const state = this.sessionMap.get(sessionId)
    if (state?.isWorking && state.abortController) {
      state.abortController.abort()
      this.markCompleted(sessionId, { event: 'run.failed', run_id: state.runId })
    }
  }

  /** Mark a session run as completed/failed so reconnecting clients get notified */
  private markCompleted(sessionId: string, _info: { event: string; run_id?: string }) {
    const state = this.sessionMap.get(sessionId)
    if (state) {
      state.isWorking = false
      state.abortController = undefined
      state.runId = undefined
      state.events = []
    }
  }

  /** Get or create session state in sessionMap */
  private getOrCreateSession(sessionId: string): SessionState {
    let state = this.sessionMap.get(sessionId)
    if (!state) {
      state = { messages: [], isWorking: false, events: [] }
      this.sessionMap.set(sessionId, state)
    }
    return state
  }

  /** Append a state event for a session (used for replay on reconnect) */
  private pushState(sessionId: string, event: string, data: any) {
    const state = this.getOrCreateSession(sessionId)
    state.events.push({ event, data })
  }

  /** Replace the last state with the same event name, or append if different */
  private replaceState(sessionId: string, event: string, data: any) {
    const state = this.sessionMap.get(sessionId)
    if (state) {
      const idx = state.events.findIndex(s => s.event === event)
      if (idx >= 0) {
        state.events[idx] = { event, data }
        return
      }
    }
    this.pushState(sessionId, event, data)
  }
}

/** Check if any assistant message in the list has non-empty content */
function runProducedAssistantText(messages: SessionMessage[]): boolean {
  return messages.some(m => m.role === 'assistant' && m.content?.trim())
}
