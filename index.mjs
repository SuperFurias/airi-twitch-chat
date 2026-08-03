/**
 * AIRI Twitch Chat extension.
 *
 * Connects AIRI to Twitch chat over IRC (WebSocket) and lets the character
 * read and reply to chat:
 *
 * - Chat messages are forwarded into the character's chat session
 *   (`input:text` on the local AIRI channel server).
 * - The character's reply is auto-posted back to the Twitch channel.
 * - A configuration widget (served by the extension's own loopback HTTP
 *   server) provides manual Connect/Disconnect, an Auto-reply toggle, and a
 *   live chat log.
 * - Four tools are registered for the character: twitch-send-message,
 *   twitch-get-messages, twitch-status, twitch-open-config.
 *
 * The entrypoint is deliberately self-contained (no bare imports, no build
 * step): it only uses Node built-ins (fs, path, url, http) and the global
 * WebSocket available in Electron's Node runtime, so the folder can be
 * dropped into `extensions/v1` of any AIRI install as-is.
 */

import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ID = 'airi-twitch-chat'
const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443'
const MAX_BUFFERED_MESSAGES = 100
const MIN_SEND_INTERVAL_MS = 1_600
const MAX_RECONNECT_DELAY_MS = 60_000
const MAX_MESSAGE_LENGTH = 500
const MODEL_RESPONSE_WINDOW_MS = 45_000

/**
 * Local kit references for `ctx.kits.use(...)`.
 *
 * The host resolves kits by id and creates the clients itself, so the
 * extension side only needs the stable kit ids. We cannot import the real
 * kits from `@proj-airi/plugin-sdk-tamagotchi` here: that package is private
 * and unresolvable from an extension folder outside the repo.
 */
const toolKitRef = { id: 'kit.tool', version: '1.0.0', createClient: () => ({}) }
const gameletKitRef = { id: 'kit.gamelet', version: '1.0.0', createClient: () => ({}) }

function log(...args) {
  console.info(`[${PLUGIN_ID}]`, ...args)
}

function logError(...args) {
  console.error(`[${PLUGIN_ID}]`, ...args)
}

function normalizeChannels(channels) {
  return (Array.isArray(channels) ? channels : [])
    .map(channel => String(channel).trim())
    .filter(Boolean)
    .map(channel => (channel.startsWith('#') ? channel : `#${channel}`))
}

function unescapeIrcValue(value) {
  return value.replaceAll('\\s', ' ').replaceAll('\\:', ';').replaceAll('\\\\', '\\')
}

function parseTags(tagsString) {
  const tags = {}
  if (!tagsString) {
    return tags
  }
  for (const part of tagsString.split(';')) {
    const separatorIndex = part.indexOf('=')
    if (separatorIndex === -1) {
      continue
    }
    const key = part.slice(0, separatorIndex)
    const value = unescapeIrcValue(part.slice(separatorIndex + 1))
    if (value) {
      tags[key] = value
    }
  }
  return tags
}

/** Parses one IRC PRIVMSG line into a chat entry. */
function parsePrivmsg(line) {
  const match = line.match(/^@([^\s]+) :[^ ]+ PRIVMSG (#[^ ]+) :(.*)$/)
  if (!match) {
    return undefined
  }
  const [, tagsString, channel, text] = match
  const tags = parseTags(tagsString)
  return {
    channel,
    user: tags['user-id'] ? tags['user-id'] : tags['display-name'] ?? '',
    displayName: tags['display-name'] ?? '',
    text,
    isMod: tags['mod'] === '1',
    isSub: tags['subscriber'] === '1',
    color: tags['color'] ?? '',
    at: new Date().toISOString(),
  }
}

function createTwitchState() {
  return {
    ws: undefined,
    reconnectAttempt: 0,
    reconnectTimer: undefined,
    configWatchTimer: undefined,
    connected: false,
    manuallyDisconnected: false,
    status: 'disconnected',
    lastError: '',
    channels: [],
    joinedChannels: [],
    buffers: new Map(),
    sendQueue: [],
    sendTimer: undefined,
    lastSendAt: 0,
    sentCount: 0,
    connectedAt: '',
    configServer: undefined,
    bridgeWs: undefined,
    bridgeReady: false,
    bridgeReconnectTimer: undefined,
    bridgeHeartbeatTimer: undefined,
    lastForwardAt: 0,
    lastForwardKey: '',
    lastAutoSendAt: 0,
    pendingReplyTimer: undefined,
    pendingReplyText: '',
    stagePeers: [],
    ingestTargets: [],
    chatLog: [],
    config: undefined,
    lastOutputAt: 0,
    modelWarning: false,
    modelWarningTimer: undefined,
  }
}

function pushToBuffer(state, entry) {
  let messages = state.buffers.get(entry.channel)
  if (!messages) {
    messages = []
    state.buffers.set(entry.channel, messages)
  }
  messages.push(entry)
  if (messages.length > MAX_BUFFERED_MESSAGES) {
    messages.splice(0, messages.length - MAX_BUFFERED_MESSAGES)
  }
}

function botName(state) {
  const name = state.config && state.config.username
  return (typeof name === 'string' && name.trim()) ? name.trim() : 'AIRI'
}

function pushToChatLog(state, kind, user, text) {
  state.chatLog.push({
    kind,
    user,
    text: String(text).slice(0, MAX_MESSAGE_LENGTH),
    at: new Date().toISOString(),
  })
  if (state.chatLog.length > 100) {
    state.chatLog.splice(0, state.chatLog.length - 100)
  }
}

function configIsValid(config) {
  return Boolean(
    config
    && typeof config.username === 'string' && config.username.trim()
    && typeof config.oauth === 'string' && config.oauth.trim()
    && !config.oauth.includes('your_chat_token'),
  )
}

function loadConfig(configPath) {
  try {
    if (!existsSync(configPath)) {
      return undefined
    }
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') {
      return undefined
    }
    return {
      username: String(parsed.username ?? '').trim(),
      oauth: String(parsed.oauth ?? '').trim(),
      channels: normalizeChannels(parsed.channels),
      autoReply: typeof parsed.autoReply === 'boolean' ? parsed.autoReply : true,
      replyCooldownMs: Number.isFinite(Number(parsed.replyCooldownMs)) && Number(parsed.replyCooldownMs) > 0
        ? Number(parsed.replyCooldownMs)
        : 5_000,
    }
  }
  catch (error) {
    logError('failed to read config.json:', error instanceof Error ? error.message : String(error))
    return undefined
  }
}

/**
 * Normalizes one config payload submitted by the configuration widget.
 * An empty `oauth` keeps the currently saved token.
 */
function normalizeConfigInput(input, current) {
  const record = (input && typeof input === 'object' ? input : {})
  const username = String(record.username ?? '').trim()
  if (!username) {
    throw new Error('username is required')
  }
  let oauth = String(record.oauth ?? '').trim()
  if (oauth) {
    if (oauth.toLowerCase().includes('your_chat_token')) {
      throw new Error('that is the example placeholder — paste a real chat token')
    }
    oauth = oauth.startsWith('oauth:') ? oauth : `oauth:${oauth}`
  }
  else {
    oauth = current?.oauth ?? ''
  }
  const channels = normalizeChannels(
    typeof record.channels === 'string'
      ? record.channels.split(',').map(channel => channel.trim())
      : record.channels,
  )
  if (channels.length === 0) {
    throw new Error('at least one channel is required')
  }
  return {
    username,
    oauth,
    channels,
    autoReply: typeof record.autoReply === 'boolean' ? record.autoReply : (current?.autoReply ?? true),
    replyCooldownMs: Number.isFinite(Number(record.replyCooldownMs)) && Number(record.replyCooldownMs) > 0
      ? Number(record.replyCooldownMs)
      : (current?.replyCooldownMs ?? 5_000),
  }
}

function buildStatusPayload(state, config) {
  const perChannel = {}
  for (const [channel, messages] of state.buffers.entries()) {
    perChannel[channel] = messages.length
  }
  return {
    ok: true,
    connected: state.connected,
    status: state.status,
    lastError: state.lastError,
    channels: config?.channels ?? [],
    joinedChannels: state.joinedChannels,
    sentCount: state.sentCount,
    buffered: perChannel,
    connectedAt: state.connectedAt,
    autoReply: config?.autoReply !== false,
    bridge: state.bridgeReady,
    modelWarning: state.modelWarning,
    lastOutputAt: state.lastOutputAt,
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/**
 * Starts a fresh chat conversation in the AIRI main window.
 *
 * The channel protocol has no chat-reset event and the widget iframe is
 * sandboxed, so the extension drives the renderer through Chrome DevTools
 * Protocol on the launcher's `--remote-debugging-port=9223`. It creates a new
 * session for the active card (which also picks up the current system prompt)
 * and deletes the previous session.
 *
 * NOTICE: requires the app to run with the remote debugging port open — the
 * launcher in `windows-workaround/` (AIRI-official.bat) does this. Without it
 * the endpoint returns a clear error and the widget shows it.
 */
async function clearChatViaCdp() {
  let targets
  try {
    const response = await fetch('http://127.0.0.1:9223/json/list')
    targets = await response.json()
  }
  catch {
    throw new Error('debug port 9223 unreachable — restart AIRI with the launcher (AIRI-official.bat)')
  }
  const target = targets.find(t => t.type === 'page' && t.url.includes('#/'))
  if (!target) {
    throw new Error('main window not found on the debug port')
  }
  const expression = `(async () => {
    const app = document.querySelector('#app')?.__vue_app__
    const pinia = app?.config?.globalProperties?.$pinia
    const chatSession = pinia?._s?.get('chat-session')
    const cardStore = pinia?._s?.get('airi-card')
    if (!chatSession || !cardStore) return { ok: false, error: 'chat store unavailable' }
    const oldId = chatSession.activeSessionId
    const newId = await chatSession.createSession(cardStore.activeCardId, { setActive: true })
    if (oldId && oldId !== newId) {
      try { await chatSession.deleteSession(oldId) } catch (e) {}
    }
    return { ok: true, newSessionId: newId, clearedSession: oldId }
  })()`
  const result = await new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error('CDP evaluation timed out'))
    }, 15_000)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }))
    })
    ws.addEventListener('message', event => {
      const msg = JSON.parse(String(event.data))
      if (msg.id !== 1) {
        return
      }
      clearTimeout(timer)
      try { ws.close() } catch {}
      const value = msg.result?.result?.value
      if (msg.result?.exceptionDetails) {
        reject(new Error('failed to evaluate in the app window'))
        return
      }
      if (value && typeof value === 'object' && value.ok === false) {
        reject(new Error(value.error || 'failed to clear the chat'))
        return
      }
      resolve(value)
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP websocket error'))
    })
  })
  return result
}

function sendLine(state, line) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(line)
    return true
  }
  return false
}

function scheduleReconnect(state, config) {
  if (state.reconnectTimer) {
    return
  }
  const delay = Math.min(1_000 * (2 ** state.reconnectAttempt), MAX_RECONNECT_DELAY_MS)
  state.reconnectAttempt += 1
  state.status = 'reconnecting'
  state.lastError = `connection lost, retrying in ${Math.round(delay / 1000)}s`
  log(`connection lost, retrying in ${Math.round(delay / 1000)}s`)
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = undefined
    connect(state, config)
  }, delay)
}

/**
 * Closes the current IRC session. With `manual: true` the session is marked
 * as user-disconnected: no auto-reconnect, status becomes 'disconnected'.
 */
function closeSocket(state, { manual = false } = {}) {
  if (state.sendTimer) {
    clearTimeout(state.sendTimer)
    state.sendTimer = undefined
  }
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = undefined
  }
  state.sendQueue = []
  state.connected = false
  state.joinedChannels = []
  if (manual) {
    state.manuallyDisconnected = true
    state.reconnectAttempt = 0
    state.status = 'disconnected'
    state.lastError = ''
  }
  if (state.ws) {
    const ws = state.ws
    state.ws = undefined
    try {
      ws.close()
    }
    catch {
      // socket already gone
    }
  }
}

function connect(state, config) {
  if (!configIsValid(config)) {
    state.status = 'missing-config'
    state.lastError = 'config.json is missing or the oauth token is not set'
    log(state.lastError, '(see config.example.json)')
    return
  }

  closeSocket(state)
  state.manuallyDisconnected = false

  const ws = new WebSocket(TWITCH_IRC_URL)
  state.ws = ws

  ws.addEventListener('open', () => {
    state.reconnectAttempt = 0
    state.status = 'connecting'
    log('connected to Twitch IRC, joining', config.channels.join(', '))
    sendLine(state, 'CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership')
    sendLine(state, `PASS ${config.oauth.startsWith('oauth:') ? config.oauth : `oauth:${config.oauth}`}`)
    sendLine(state, `NICK ${config.username.toLowerCase()}`)
    for (const channel of config.channels) {
      sendLine(state, `JOIN ${channel}`)
    }
  })

  ws.addEventListener('message', event => {
    const data = String(event.data ?? '')
    for (const line of data.split('\r\n')) {
      if (!line) {
        continue
      }
      if (line.startsWith('ERROR')) {
        logError('twitch error:', line)
      }
      handleLine(state, config, line)
    }
  })

  ws.addEventListener('error', () => {
    state.status = 'error'
    state.lastError = 'websocket error'
    logError('twitch websocket error')
  })

  ws.addEventListener('close', event => {
    log(`twitch connection closed (code=${event.code})`)
    state.connected = false
    state.joinedChannels = []
    if (state.ws !== ws) {
      // Stale socket: closed by closeSocket() while a newer connect replaced
      // it. Scheduling a reconnect here would re-enter connect(), whose
      // closeSocket() then closes the fresh socket, flapping forever.
      return
    }
    state.ws = undefined
    if (state.manuallyDisconnected) {
      state.status = 'disconnected'
      return
    }
    scheduleReconnect(state, config)
  })
}

function handleLine(state, config, line) {
  if (line.startsWith('PING')) {
    sendLine(state, 'PONG :tmi.twitch.tv')
    return
  }

  if (line.startsWith('RECONNECT')) {
    log('twitch requested reconnect')
    if (state.ws) {
      state.ws.close()
    }
    return
  }

  if (line.includes(' PRIVMSG ')) {
    const entry = parsePrivmsg(line)
    if (entry) {
      pushToBuffer(state, entry)
      pushToChatLog(state, 'chat', entry.displayName || entry.user, entry.text)
      forwardToCharacter(state, config, entry)
    }
    return
  }

  if (line.includes(' JOIN ')) {
    const channelMatch = line.match(/JOIN (#[^ ]+)/)
    if (channelMatch && !state.joinedChannels.includes(channelMatch[1])) {
      state.joinedChannels.push(channelMatch[1])
    }
    return
  }

  if (line.includes(' NOTICE ')) {
    const noticeMatch = line.match(/NOTICE #[^ ]+ :(.*)$/)
    if (noticeMatch) {
      log('twitch notice:', noticeMatch[1])
    }
    return
  }

  if (line.startsWith(':tmi.twitch.tv 001 ')) {
    state.connected = true
    state.connectedAt = new Date().toISOString()
    state.status = 'connected'
    log(`authenticated as ${config.username}, ready`)
  }

  if (line.startsWith(':tmi.twitch.tv 353 ')) {
    const namesMatch = line.match(/353 [^:]+ = (#[^ ]+) :(.*)$/)
    if (namesMatch && !state.joinedChannels.includes(namesMatch[1])) {
      state.joinedChannels.push(namesMatch[1])
    }
    return
  }

  if (line.startsWith('ERROR')) {
    state.lastError = `twitch error: ${line}`
    logError(state.lastError)
  }
}

/**
 * Queues a message for sending. Twitch drops messages longer than 500
 * characters, so the hard limit is enforced here, at the send boundary,
 * covering every path (tool calls, auto-post, tests).
 */
function enqueueSend(state, channel, message) {
  const safeMessage = String(message ?? '').slice(0, MAX_MESSAGE_LENGTH)
  state.sendQueue.push({ channel, message: safeMessage })
  processSendQueue(state)
}

function processSendQueue(state) {
  if (state.sendTimer || state.sendQueue.length === 0) {
    return
  }
  const waitMs = Math.max(0, state.lastSendAt + MIN_SEND_INTERVAL_MS - Date.now())
  state.sendTimer = setTimeout(() => {
    state.sendTimer = undefined
    const next = state.sendQueue.shift()
    if (!next) {
      return
    }
    state.lastSendAt = Date.now()
    state.sentCount += 1
    sendLine(state, `PRIVMSG ${next.channel} :${next.message}`)
    processSendQueue(state)
  }, waitMs)
}

function channelFor(config, requestedChannel) {
  if (requestedChannel) {
    return normalizeChannels([requestedChannel])[0]
  }
  return config.channels[0]
}

/**
 * AIRI channel bridge.
 *
 * Connects to the local channel server (ws://127.0.0.1:6121) as an extension
 * module so the extension can emit `input:text` events. The main window's
 * renderer ingests those into the character. The auth token (when
 * configured) is read from `server-channel-config.json` in the app userData
 * — the same file the channel server persists.
 */
function startChannelBridge(state, rootDir) {
  const userData = dirname(dirname(dirname(rootDir)))
  let authToken = ''
  try {
    const parsed = JSON.parse(readFileSync(join(userData, 'server-channel-config.json'), 'utf8'))
    authToken = String(parsed.authToken ?? '').trim()
  }
  catch {
    log('channel bridge: no server-channel-config.json found — connecting without auth')
  }

  const connectBridge = () => {
    if (state.bridgeWs) {
      return
    }
    const ws = new WebSocket('ws://127.0.0.1:6121/ws')
    state.bridgeWs = ws

    ws.addEventListener('open', () => {
      if (authToken) {
        ws.send(JSON.stringify({ type: 'module:authenticate', data: { token: authToken } }))
      }
      else {
        announceBridge(state)
      }
      if (state.bridgeHeartbeatTimer) {
        clearInterval(state.bridgeHeartbeatTimer)
      }
      // Keep the peer healthy: the server marks peers without heartbeats as
      // unhealthy after ~60s and may drop them.
      state.bridgeHeartbeatTimer = setInterval(() => {
        if (state.bridgeWs && state.bridgeWs.readyState === WebSocket.OPEN) {
          state.bridgeWs.send(JSON.stringify({
            type: 'transport:connection:heartbeat',
            data: { kind: 'ping', message: 'ping', at: Date.now() },
          }))
        }
      }, 25_000)
    })

    ws.addEventListener('message', event => {
      let message
      try {
        const envelope = JSON.parse(String(event.data))
        // The channel server serializes with SuperJSON: `{ "json": {...}, "meta": ... }`.
        message = envelope && typeof envelope === 'object' && 'json' in envelope ? envelope.json : envelope
      }
      catch {
        return
      }
      handleBridgeMessage(state, message)
    })

    ws.addEventListener('close', () => {
      state.bridgeReady = false
      if (state.bridgeHeartbeatTimer) {
        clearInterval(state.bridgeHeartbeatTimer)
        state.bridgeHeartbeatTimer = undefined
      }
      if (state.bridgeWs === ws) {
        state.bridgeWs = undefined
      }
      if (state.bridgeReconnectTimer) {
        return
      }
      state.bridgeReconnectTimer = setTimeout(() => {
        state.bridgeReconnectTimer = undefined
        connectBridge()
      }, 5_000)
    })
  }

  connectBridge()
}

function handleBridgeMessage(state, message) {
  if (message.type === 'module:authenticated' && message.data && message.data.authenticated === true) {
    announceBridge(state)
    return
  }

  if (message.type === 'extension:module:announced'
    && message.data
    && message.data.identity
    && message.data.identity.id === 'airi-twitch-chat-bridge') {
    state.bridgeReady = true
    log('channel bridge ready — forwarding chat to the character')
    return
  }

  if (message.type === 'registry:modules:sync' && message.data) {
    try {
      const modules = message.data.modules || []
      for (const m of modules) {
        if (m.name === 'proj-airi:stage-tamagotchi' && m.identity && m.identity.id) {
          if (!state.stagePeers.includes(m.identity.id)) {
            state.stagePeers.push(m.identity.id)
          }
        }
      }
      // Ingest-capable windows: the character window (`#/`) and the widgets
      // window. The widgets window is the FIRST stage peer to join (the
      // extension opens it at setup), and forwarding to it duplicates the
      // response. The auxiliary chat window (`#/chat`) joins last but has no
      // context bridge. So the forward targets every stage peer EXCEPT the
      // first-joined one.
      state.ingestTargets = state.stagePeers.slice(1)
    }
    catch {
      // registry sync unparseable; keep the previous targets
    }
    return
  }

  if (message.type === 'extension:module:de-announced' && message.data) {
    const id = message.data.identity && message.data.identity.id
    if (id && message.data.name === 'proj-airi:stage-tamagotchi') {
      state.stagePeers = state.stagePeers.filter(peer => peer !== id)
      state.ingestTargets = state.stagePeers.slice(1)
    }
    return
  }

  if (message.type === 'output:gen-ai:chat:message' && message.data) {
    noteAirOutput(state)
    return
  }

  if (message.type === 'output:gen-ai:chat:complete' && message.data) {
    noteAirOutput(state)
    // Auto-post the character's reply to Twitch when the reply was triggered
    // by a recent Twitch forward. The real reply text lives in
    // `message.data.message.content`; the top-level `text` is the input echo.
    // The post is debounced: the latest reply within 5s wins (the one the UI
    // keeps), and a cooldown prevents double-posting.
    const replyText = (message.data.message && message.data.message.content)
      || (message.data.message && message.data.message.text)
      || message.data.text
      || ''
    if (
      typeof replyText === 'string' && replyText.trim()
      && state.connected
      && state.config && state.config.autoReply !== false
      && Date.now() - state.lastForwardAt < 30_000
    ) {
      if (state.pendingReplyTimer) {
        clearTimeout(state.pendingReplyTimer)
      }
      state.pendingReplyText = replyText.trim()
      state.pendingReplyTimer = setTimeout(() => {
        state.pendingReplyTimer = undefined
        const channel = state.config && state.config.channels[0]
        if (channel && state.connected && Date.now() - state.lastAutoSendAt > 12_000) {
          state.lastAutoSendAt = Date.now()
          enqueueSend(state, channel, state.pendingReplyText)
          pushToChatLog(state, 'reply', botName(state), state.pendingReplyText)
          log('auto-posted reply to', channel)
        }
      }, 5_000)
    }
  }
}

function announceBridge(state) {
  if (!state.bridgeWs || state.bridgeWs.readyState !== WebSocket.OPEN) {
    return
  }
  state.bridgeWs.send(JSON.stringify({
    type: 'extension:module:announce',
    data: {
      name: 'airi-twitch-chat',
      identity: { id: 'airi-twitch-chat-bridge', extension: { id: 'airi-twitch-chat' } },
      possibleEvents: ['input:text'],
    },
  }))
}

/**
 * Records any generation output from AIRI and clears the "no model selected"
 * watchdog. The renderer ingests `input:text` into the character's context,
 * but only generates (and emits `output:gen-ai:chat:*`) when a provider and a
 * model are selected — see context-bridge.ts (activeProvider/activeModel
 * gate). With no model, the message is silently ignored, so the absence of
 * any output event after a forward is the only observable failure signal.
 */
function noteAirOutput(state) {
  state.lastOutputAt = Date.now()
  state.modelWarning = false
  if (state.modelWarningTimer) {
    clearTimeout(state.modelWarningTimer)
    state.modelWarningTimer = undefined
  }
}

/**
 * Starts the watchdog that warns when the character never answers a forwarded
 * Twitch message. The warning points at the model selection because AIRI
 * silently drops input without an active chat model.
 */
function armModelWatchdog(state) {
  if (state.modelWarningTimer) {
    clearTimeout(state.modelWarningTimer)
  }
  state.modelWarningTimer = setTimeout(() => {
    state.modelWarningTimer = undefined
    if (state.lastOutputAt >= state.lastForwardAt) {
      return
    }
    state.modelWarning = true
    pushToChatLog(state, 'warn', botName(state), 'No reply from the character within 45s — check that a model is selected in AIRI (Settings → model)')
    log('model warning: character produced no output after a forward')
  }, MODEL_RESPONSE_WINDOW_MS)
}

function stopChannelBridge(state) {
  if (state.bridgeReconnectTimer) {
    clearTimeout(state.bridgeReconnectTimer)
    state.bridgeReconnectTimer = undefined
  }
  if (state.bridgeHeartbeatTimer) {
    clearInterval(state.bridgeHeartbeatTimer)
    state.bridgeHeartbeatTimer = undefined
  }
  if (state.pendingReplyTimer) {
    clearTimeout(state.pendingReplyTimer)
    state.pendingReplyTimer = undefined
  }
  state.bridgeReady = false
  if (state.modelWarningTimer) {
    clearTimeout(state.modelWarningTimer)
    state.modelWarningTimer = undefined
  }
  if (state.bridgeWs) {
    const ws = state.bridgeWs
    state.bridgeWs = undefined
    try {
      ws.close()
    }
    catch {
      // socket already gone
    }
  }
}

/**
 * Forwards one chat entry to the character via the channel, gated by the
 * auto-reply toggle, a cooldown, a duplicate-delivery guard (Twitch IRC can
 * deliver the same line more than once), and the bot's own messages (Twitch
 * echoes them back, which would otherwise create a reply loop).
 */
function forwardToCharacter(state, config, entry) {
  if (!state.connected || !state.bridgeReady) {
    return
  }
  if (!config || config.autoReply === false) {
    return
  }
  const ownName = String(config.username ?? '').toLowerCase()
  if (ownName && String(entry.displayName || '').toLowerCase() === ownName) {
    return
  }
  const now = Date.now()
  const normalized = `${entry.displayName}:${entry.text}`
  if (normalized === state.lastForwardKey && now - state.lastForwardAt < 5_000) {
    return
  }
  state.lastForwardKey = normalized
  const cooldownMs = config.replyCooldownMs ?? 5_000
  if (now - state.lastForwardAt < cooldownMs) {
    return
  }
  state.lastForwardAt = now
  const text = `[Twitch] ${entry.displayName || entry.user}: ${entry.text}`
  if (state.bridgeWs && state.bridgeWs.readyState === WebSocket.OPEN) {
    // NOTICE: input:text defaults to consumer-group delivery, and the server
    // excludes the SENDER from consumer selection — so an event sent through
    // the bridge's own ws would be dropped ("no consumer registered"). Force
    // broadcast routing so the renderer clients receive and ingest it, and
    // target the ingest-capable windows only (all stage peers except the
    // first-joined widgets window) to avoid a duplicated response.
    // Root cause: server-runtime selectConsumerPeerId filters
    // `entry.peerId !== fromPeerId`.
    // Removal condition: once renderer clients reliably register as
    // input:text consumers, plain delivery works again.
    const envelope = {
      type: 'input:text',
      data: { text },
      route: { delivery: { mode: 'broadcast' } },
    }
    if (state.ingestTargets && state.ingestTargets.length > 0) {
      envelope.route.destinations = state.ingestTargets
    }
    state.bridgeWs.send(JSON.stringify(envelope))
    log('forwarded to the character:', text.slice(0, 140))
    armModelWatchdog(state)
  }
}

/**
 * Starts the loopback HTTP server that powers the in-app configuration
 * widget: serves the plugin's own `ui/index.html` (re-read on every request
 * so UI edits apply without a reload) and the JSON API endpoints.
 * Bound to 127.0.0.1 only; same-origin requests, so no CORS headers.
 */
async function startConfigServer(state, configPath, rootDir, getConfig) {
  const uiHtmlPath = join(rootDir, 'ui', 'index.html')

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const pathname = url.pathname

      if (request.method === 'GET' && (pathname === '/ui' || pathname === '/')) {
        const html = existsSync(uiHtmlPath) ? readFileSync(uiHtmlPath, 'utf8') : '<h1>ui/index.html is missing</h1>'
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(html)
        return
      }

      if (request.method === 'GET' && pathname === '/api/status') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(buildStatusPayload(state, getConfig())))
        return
      }

      if (request.method === 'GET' && pathname === '/api/config') {
        const current = getConfig()
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({
          username: current?.username ?? '',
          channels: current?.channels ?? [],
          oauthSet: Boolean(current?.oauth),
          autoReply: current?.autoReply !== false,
          replyCooldownMs: current?.replyCooldownMs ?? 5_000,
        }))
        return
      }

      if (request.method === 'GET' && pathname === '/api/chatlog') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: true, entries: state.chatLog.slice(-50) }))
        return
      }

      if (request.method === 'POST' && pathname === '/api/config') {
        const body = JSON.parse(await readRequestBody(request))
        const next = normalizeConfigInput(body, getConfig())
        writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8')
        log('config.json saved via configuration widget')
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: true }))
        return
      }

      if (request.method === 'POST' && pathname === '/api/connect') {
        const current = getConfig()
        if (!configIsValid(current)) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ ok: false, error: 'config.json is missing or incomplete' }))
          return
        }
        log('manual connect requested')
        connect(state, current)
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: true, status: state.status }))
        return
      }

      if (request.method === 'POST' && pathname === '/api/disconnect') {
        log('manual disconnect requested')
        closeSocket(state, { manual: true })
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: true, status: state.status }))
        return
      }

      if (request.method === 'POST' && pathname === '/api/clear-chat') {
        try {
          const result = await clearChatViaCdp()
          log('chat cleared via CDP:', JSON.stringify(result))
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ ok: true, ...result }))
        }
        catch (error) {
          logError('failed to clear chat:', error instanceof Error ? error.message : String(error))
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        }
        return
      }

      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('not found')
    }
    catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  state.configServer = server
  return port
}

async function setup(ctx) {
  const rootDir = dirname(fileURLToPath(import.meta.url))
  const configPath = join(rootDir, 'config.json')

  const state = createTwitchState()
  let config = loadConfig(configPath)
  state.config = config

  state.status = configIsValid(config) ? 'disconnected' : 'missing-config'
  state.lastError = configIsValid(config) ? '' : 'config.json is missing or incomplete'

  log('setup', { extensionId: ctx.extension.id, sessionId: ctx.extension.sessionId, configPath })
  log('connection is manual — use the Connect button in the config widget')

  // Watch the plugin folder for config.json changes. Saving new credentials
  // while connected disconnects first (no auto-reconnect); Connect applies.
  let folderWatcher
  try {
    folderWatcher = watch(rootDir, { persistent: false }, (eventType, filename) => {
      if (filename !== 'config.json') {
        return
      }
      if (state.configWatchTimer) {
        clearTimeout(state.configWatchTimer)
      }
      state.configWatchTimer = setTimeout(() => {
        state.configWatchTimer = undefined
        const nextConfig = loadConfig(configPath)
        if (JSON.stringify(nextConfig) !== JSON.stringify(config)) {
          config = nextConfig
          state.config = config
          log('config.json changed')
          if (state.ws || state.connected || state.reconnectTimer) {
            closeSocket(state, { manual: true })
            log('disconnected — press Connect to apply the new credentials')
          }
          else {
            state.status = configIsValid(config) ? 'disconnected' : 'missing-config'
            state.lastError = configIsValid(config) ? '' : 'config.json is missing or incomplete'
          }
        }
      }, 200)
    })
  }
  catch (error) {
    logError('failed to watch config.json:', error instanceof Error ? error.message : String(error))
  }

  // Configuration widget: loopback HTTP server serving the plugin's own UI.
  // The gamelet iframe uses `src` directly (the host passes arbitrary URLs
  // through), so the page is same-origin with its API and needs no bridge.
  let configUiPort
  try {
    configUiPort = await startConfigServer(state, configPath, rootDir, () => config)
    log('config UI server at', `http://127.0.0.1:${configUiPort}/ui`)
  }
  catch (error) {
    logError('failed to start config UI server:', error instanceof Error ? error.message : String(error))
  }

  let gamelets
  let configBindingId
  if (configUiPort) {
    try {
      gamelets = await ctx.kits.use(gameletKitRef)
      configBindingId = 'twitch-chat-config'
      await gamelets.mount({
        bindingId: configBindingId,
        title: 'Twitch Chat',
        ui: gamelets.iframe({
          src: `http://127.0.0.1:${configUiPort}/ui`,
          sandbox: 'allow-scripts allow-same-origin allow-forms',
        }),
      })
      log('config widget mounted as', configBindingId)
      await gamelets.orchestration.open(configBindingId)
      log('opened config widget')
    }
    catch (error) {
      logError('failed to mount config widget:', error instanceof Error ? error.message : String(error))
    }
  }

  const tools = await ctx.kits.use(toolKitRef)

  await tools.registerToolsetPrompt({
    id: 'twitch-chat.guidance',
    prompt: {
      title: 'Twitch Chat',
      content: [
        'You are streaming live on Twitch and your chat messages arrive in the format "[Twitch] viewer: message".',
        'Whenever a viewer sends a Twitch chat message, you MUST reply to it by calling the twitch-send-message tool with your reply in the "message" parameter.',
        'Never respond to a Twitch chat message without calling twitch-send-message — the viewer cannot see your other output.',
        'Keep replies short, lively, and on-topic; Twitch chat moves fast.',
        'Use the twitch-get-messages tool to read recent chat messages.',
        'Use the twitch-status tool to check the Twitch connection.',
        'Use the twitch-open-config tool when the user asks to change Twitch settings.',
      ].join(' '),
    },
  })

  await tools.registerTool({
    id: 'twitch-send-message',
    title: 'Twitch: send chat message',
    description: 'Sends a message to a Twitch channel chat. Messages are truncated to 500 characters and rate-limited (max ~20 messages per 30 seconds). Returns ok:true on success.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel to send to, with or without the # prefix. Defaults to the first configured channel.',
        },
        message: {
          type: 'string',
          description: 'The chat message to send.',
        },
      },
      required: ['message'],
    },
    execute: async input => {
      const payload = (input && typeof input === 'object' ? input : {})
      const message = String(payload.message ?? '').trim()
      const channel = channelFor(config, payload.channel)
      if (!message) {
        return { ok: false, error: 'message is empty' }
      }
      if (!channel) {
        return { ok: false, error: 'no Twitch channel configured' }
      }
      if (!state.connected) {
        return { ok: false, error: `not connected to Twitch (${state.status})` }
      }
      enqueueSend(state, channel, message)
      pushToChatLog(state, 'reply', botName(state), message)
      return { ok: true, channel, queued: true }
    },
  })

  await tools.registerTool({
    id: 'twitch-get-messages',
    title: 'Twitch: read recent chat messages',
    description: 'Returns the most recent Twitch chat messages for a channel (newest first). Use this to see what viewers are saying.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel to read from, with or without the # prefix. Defaults to the first configured channel.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of messages to return (default 20).',
        },
      },
      required: [],
    },
    execute: async input => {
      const payload = (input && typeof input === 'object' ? input : {})
      const channel = channelFor(config, payload.channel)
      const limit = Math.max(1, Math.min(100, Number(payload.limit ?? 20) || 20))
      if (!channel) {
        return { ok: false, error: 'no Twitch channel configured' }
      }
      const messages = (state.buffers.get(channel) ?? []).slice(-limit).reverse()
      return {
        ok: true,
        channel,
        connected: state.connected,
        count: messages.length,
        messages: messages.map(entry => ({
          user: entry.user,
          displayName: entry.displayName || entry.user,
          text: entry.text,
          isMod: entry.isMod,
          isSub: entry.isSub,
          at: entry.at,
        })),
      }
    },
  })

  await tools.registerTool({
    id: 'twitch-status',
    title: 'Twitch: connection status',
    description: 'Reports whether the Twitch chat connection is alive, which channels are joined, and how many messages are buffered per channel.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async () => {
      return buildStatusPayload(state, config)
    },
  })

  await tools.registerTool({
    id: 'twitch-open-config',
    title: 'Twitch: open chat configuration',
    description: 'Opens the Twitch Chat configuration widget so the user can edit credentials and channels.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async () => {
      if (!gamelets || !configBindingId) {
        return { ok: false, error: 'configuration widget is unavailable' }
      }
      await gamelets.orchestration.open(configBindingId)
      return { ok: true, url: `http://127.0.0.1:${configUiPort}/ui` }
    },
  })

  log('tools registered: twitch-send-message, twitch-get-messages, twitch-status, twitch-open-config')

  startChannelBridge(state, rootDir)

  ctx.subscriptions.add({
    dispose: () => {
      closeSocket(state)
      stopChannelBridge(state)
      if (folderWatcher) {
        folderWatcher.close()
      }
      if (state.configServer) {
        try {
          state.configServer.close()
        }
        catch {
          // server already closed
        }
      }
    },
  })
}

export default {
  id: PLUGIN_ID,
  setup,
}




















