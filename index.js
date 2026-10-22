/**
 * Host half of @local/next-suggestion.
 *
 * Serves one tiny HTTP surface to the Web UI:
 *   GET  /dsh-next-suggestion/get?sessionId=...   -> { text }
 *   POST /dsh-next-suggestion/consume             -> { ok: true }
 *
 * The prediction itself is produced from the live session log with the
 * ordinary `llm` service, cached per (session, log length) so repeated
 * polls cost nothing and every finished turn is paid for at most once.
 */

const ROUTE = '/dsh-next-suggestion'
const REASONING_EFFORT = 'low'
const KEEP_MESSAGES = 5
const MAX_MESSAGE_CHARS = 300
const MAX_USER_CHARS = 400
const MAX_TRANSCRIPT_CHARS = 3200
const MAX_SUGGESTION_CHARS = 120
const CACHE_LIMIT = 200
const TIMEOUT_MS = 25000
const STABLE_MS = 1200

const SYSTEM_PROMPT = [
  'You are modelling the human USER of this chat, not the assistant.',
  'The transcript below ends with a marker, and your job is to write the message the USER types next.',
  'Rules:',
  '- Output ONLY the user message text: no quotes, no labels, no markdown, no explanation.',
  '- Write in the user\'s language and tone, matching the transcript (usually Chinese, English is fine).',
  '- At most 20 words / one short sentence.',
  '- Never continue, summarise or answer the ASSISTANT text. Never speak as the assistant.',
  '- The assistant just finished a turn, so predict what this user would realistically say next:',
  '  approve it and move on, ask for a specific fix, redirect the approach, or state the next requirement.',
  '- Be concrete: name the file, feature or step the user would actually mention.',
  '- Reply with the plain message text only: no tool calls, no tags, no special markers.',
].join('\n')

function textOf(message) {
  const content = message && message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
  }
  return parts.join('\n').trim()
}

function roleOf(message) {
  const role = message && message.role
  return typeof role === 'string' ? role : ''
}

function buildTranscript(messages) {
  if (!Array.isArray(messages)) return ''
  const lines = []
  for (const message of messages) {
    const role = roleOf(message)
    let speaker = ''
    if (role === 'user') speaker = 'USER'
    else if (role === 'assistant') speaker = 'ASSISTANT'
    else continue
    let text = textOf(message)
    if (!text) continue
    const limit = speaker === 'USER' ? MAX_USER_CHARS : MAX_MESSAGE_CHARS
    if (text.length > limit) text = `${text.slice(0, limit)}…`
    lines.push(`${speaker}: ${text}`)
  }
  const kept = lines.slice(-KEEP_MESSAGES)
  let joined = kept.join('\n\n')
  if (joined.length > MAX_TRANSCRIPT_CHARS) joined = joined.slice(joined.length - MAX_TRANSCRIPT_CHARS)
  return joined
}

function sanitize(raw) {
  if (typeof raw !== 'string') return ''
  let text = raw.replace(/\r/g, '\n')
  // Drop special-token / markup noise some providers emit in the text channel.
  text = text.replace(/[<＜][^<>＜＞\n]{0,60}[>＞]/g, ' ')
  text = text.split('\n').find((line) => line.trim().length > 0) || ''
  text = text.trim()
  text = text.replace(/^\s*(?:USER|user|用户)\s*[:：]\s*/, '')
  text = text.replace(/^[`"'“”‘’«」]+/, '').replace(/[`"'“”‘’«」]+$/, '')
  text = text.replace(/^[-*•]\s+/, '')
  text = text.replace(/\s+/g, ' ').trim()
  // Anything without a letter or CJK character is noise, not a suggestion.
  if (!/[\p{L}\p{Script=Han}]/u.test(text)) return ''
  if (text.length > MAX_SUGGESTION_CHARS) text = `${text.slice(0, MAX_SUGGESTION_CHARS)}…`
  return text
}

function resolveTarget(selection) {
  if (!selection || typeof selection !== 'object') return null
  const provider = typeof selection.provider === 'string' ? selection.provider : selection.provider && selection.provider.id
  const model = typeof selection.model === 'string' ? selection.model : selection.model && (selection.model.id || selection.model.model)
  if (typeof provider !== 'string' || !provider) return null
  if (typeof model !== 'string' || !model) return null
  const effort = selection.reasoningEffort
  return { provider, model, effort: typeof effort === 'string' ? effort : undefined }
}

function lookupSession(ctx, raw) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function') return undefined
  const candidates = [raw]
  if (raw.startsWith('session-')) candidates.push(raw.slice('session-'.length))
  else candidates.push(`session-${raw}`)
  for (const id of candidates) {
    try {
      const found = sessions.get(id)
      if (found) return found
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) {
        data = ''
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function send(res, code, payload) {
  let body = '{}'
  try {
    body = JSON.stringify(payload)
  } catch {
    body = '{}'
  }
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

async function predict(ctx, session, signal, sink) {
  const llm = ctx.get('llm')
  const models = ctx.get('agentDefaultModel')
  if (!llm || typeof llm.stream !== 'function' || !models) return ''

  let selection
  try {
    selection = models.currentSelection()
  } catch {
    return ''
  }
  const target = resolveTarget(selection)
  if (!target) return ''

  let messages
  try {
    messages = session.deriveMessages()
  } catch {
    return ''
  }
  const transcript = buildTranscript(messages)
  if (!transcript) return ''

  const prompt = [
    transcript,
    '',
    '---',
    '以上是最近对话，最后一条 ASSISTANT 是助手刚完成的回复。',
    '现在请预测用户（USER）接下来最可能输入的那一句话。',
    '要求：只输出那一句话本身；不要写 ASSISTANT 的内容；不要调用工具；不要解释；使用对话原本的语言。',
  ].join('\n')

  const request = {
    provider: target.provider,
    model: target.model,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    temperature: 0.4,
    maxTokens: 700,
    reasoningEffort: REASONING_EFFORT,
    signal,
  }
  let out = ''
  const seen = {}
  const stream = llm.stream(request)
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    const type = typeof chunk.type === 'string' ? chunk.type : '(none)'
    seen[type] = (seen[type] || 0) + 1
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    else if (chunk.type === 'error') {
      if (sink && typeof sink === 'object') sink.err = JSON.stringify(chunk).slice(0, 300)
      break
    }
  }
  if (sink && typeof sink === 'object' && !sink.err) {
    sink.raw = out.slice(0, 400)
    sink.types = JSON.stringify(seen).slice(0, 200)
  }
  return sanitize(out)
}

export function apply(ctx) {
  const cache = new Map()
  const inflight = new Set()
  const errors = new Map()
  const raws = new Map()
  const agentStatus = new Map()
  const stability = new Map()
  const lastMs = new Map()

  const remember = (key, value) => {
    cache.delete(key)
    cache.set(key, value)
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      cache.delete(oldest.value)
    }
  }

  // Starts one prediction for `sessionId` unless the log position is already
  // cached or a generation is in flight. Used by both the poll route and the
  // idle-status prewarm.
  const startPrediction = (sessionId) => {
    if (inflight.has(sessionId)) return
    const session = lookupSession(ctx, sessionId)
    if (!session) return
    let seq = 0
    try {
      seq = typeof session.seq === 'number' ? session.seq : 0
    } catch {
      seq = 0
    }
    const cached = cache.get(sessionId)
    if (cached && cached.seq === seq && cached.text) return
    let tailRole = ''
    try {
      const messages = session.deriveMessages()
      if (Array.isArray(messages) && messages.length > 0) tailRole = roleOf(messages[messages.length - 1])
    } catch {
      return
    }
    if (tailRole !== 'assistant') return

    inflight.add(sessionId)
    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const sink = {}
    predict(ctx, session, controller.signal, sink)
      .then((text) => {
        errors.delete(sessionId)
        raws.set(sessionId, `${sink.err || ''} | ${sink.raw || '(empty)'} | ${sink.types || ''}`)
        lastMs.set(sessionId, Date.now() - startedAt)
        remember(sessionId, { seq, text })
      })
      .catch((error) => {
        errors.set(sessionId, error && error.message ? String(error.message) : String(error))
        lastMs.set(sessionId, Date.now() - startedAt)
        remember(sessionId, { seq, text: '' })
      })
      .finally(() => {
        clearTimeout(timer)
        inflight.delete(sessionId)
      })
  }

  const handler = async (req, res) => {
    let url
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      return send(res, 400, { text: '' })
    }

    const pathname = url.pathname.replace(/\/+$/, '')

    if (pathname === `${ROUTE}/get`) {
      const sessionId = url.searchParams.get('sessionId') || ''
      const debug = url.searchParams.has('debug')
      if (!sessionId) return send(res, 200, { text: '' })

      const session = lookupSession(ctx, sessionId)
      if (!session) {
        return send(res, 200, debug ? { text: '', sessionFound: false } : { text: '' })
      }

      let seq = 0
      try {
        seq = typeof session.seq === 'number' ? session.seq : 0
      } catch {
        seq = 0
      }

      // Only ask for a prediction when the log ends on an assistant message,
      // i.e. a turn just finished and the user is expected to speak next.
      let tailRole = ''
      try {
        const messages = session.deriveMessages()
        if (Array.isArray(messages) && messages.length > 0) tailRole = roleOf(messages[messages.length - 1])
      } catch (error) {
        tailRole = `derive-failed: ${error && error.message ? error.message : 'unknown'}`
      }
      const ready = tailRole === 'assistant'
      // A turn in progress means the assistant is still writing: nothing to predict yet.
      const busy = agentStatus.get(sessionId) === 'running'

      if (url.searchParams.has('refresh')) cache.delete(sessionId)
      const cached = cache.get(sessionId)
      if (debug) {
        let target = null
        try {
          const models = ctx.get('agentDefaultModel')
          target = models && typeof models.currentSelection === 'function' ? resolveTarget(models.currentSelection()) : null
        } catch (error) {
          target = { error: error && error.message ? error.message : 'unknown' }
        }
        return send(res, 200, {
          sessionFound: true,
          seq,
          tailRole,
          ready,
          busy,
          inflight: inflight.has(sessionId),
          cachedSeq: cached ? cached.seq : null,
          lastError: errors.get(sessionId) || null,
          lastRaw: raws.get(sessionId) || null,
          lastMs: lastMs.get(sessionId) || null,
          target,
          text: cached && cached.seq === seq ? cached.text : '',
        })
      }

      if (cached && cached.seq === seq && cached.text) return send(res, 200, { text: cached.text })

      if (busy) return send(res, 200, { text: '' })

      // Without a live status signal, `seq` is the only hint that the assistant
      // finished: require it to be still across one poll. Once the Host has told
      // us the agent is idle, prediction can start straight away.
      if (agentStatus.get(sessionId) !== 'idle') {
        const now = Date.now()
        const previous = stability.get(sessionId)
        if (!previous || previous.seq !== seq) {
          stability.set(sessionId, { seq, at: now })
          return send(res, 200, { text: '' })
        }
        if (now - previous.at < STABLE_MS) return send(res, 200, { text: '' })
      }

      if (!ready) {
        cache.delete(sessionId)
        return send(res, 200, { text: '' })
      }

      startPrediction(sessionId)

      return send(res, 200, { text: '' })
    }

    if (pathname === `${ROUTE}/consume`) {
      const body = await readJson(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (sessionId) {
        const session = lookupSession(ctx, sessionId)
        let seq = 0
        try {
          seq = session && typeof session.seq === 'number' ? session.seq : 0
        } catch {
          seq = 0
        }
        remember(sessionId, { seq, text: '' })
      }
      return send(res, 200, { ok: true })
    }


    return send(res, 404, { text: '' })
  }

  // `session/event` is the one live signal that reliably reaches this plugin.
  // `turn/start` marks the session busy; `turn/end` is the moment the composer
  // is about to be usable again, so warm the next prediction right there
  // instead of waiting for the browser poll and the quiet-period timer.
  ctx.on('session/event', (first, second) => {
    try {
      const args = [first, second]
      const event = args.find((value) => value && typeof value.type === 'string' && typeof value.seq === 'number')
      if (!event) return
      const owner = args.find((value) => value && value !== event && typeof value.id === 'string')
      const sessionId = owner ? owner.id : ''
      if (!sessionId) return
      if (event.type === 'turn/start') {
        agentStatus.set(sessionId, 'running')
        return
      }
      if (event.type === 'turn/end') {
        agentStatus.set(sessionId, 'idle')
        stability.delete(sessionId)
        startPrediction(sessionId)
      }
    } catch {
      /* status events must never break the plugin */
    }
  })

  ctx.on('agent/status', (payload) => {
    try {
      const agent = payload && payload.agent
      const id = agent && typeof agent.id === 'string' ? agent.id : ''
      if (!id) return
      agentStatus.set(id, payload.status === 'running' ? 'running' : 'idle')
    } catch {
      /* a malformed status payload must not break the plugin */
    }
  })

  ctx.effect(() => {
    let stopped = false
    let disposeRoute = null
    let attempt = 0

    // `webServer` may not exist yet when this plugin mounts during app startup,
    // so keep looking for it instead of giving up on the first miss.
    const tryRegister = () => {
      if (stopped || disposeRoute) return
      const webServer = ctx.get('webServer')
      if (webServer && typeof webServer.register === 'function') {
        disposeRoute = webServer.register({ kind: 'prefix', path: ROUTE, handler })
        return
      }
      if (attempt >= 300) return
      attempt += 1
      const timer = setTimeout(tryRegister, 200)
      if (timer && typeof timer.unref === 'function') timer.unref()
    }

    tryRegister()

    return () => {
      stopped = true
      cache.clear()
      inflight.clear()
      stability.clear()
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  }, 'next-suggestion.route')
}
