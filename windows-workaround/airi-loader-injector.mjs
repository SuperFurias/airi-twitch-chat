/**
 * AIRI loader-fix injector (for the official installed Windows app).
 *
 * The official AIRI Windows builds import extension entrypoints as plain
 * Windows paths (`import("C:\\...\\index.mjs")`), which Node's default ESM
 * loader rejects (`ERR_UNSUPPORTED_ESM_URL_SCHEME`) — so no extension can
 * start there, without modifying the app. This injector attaches to the
 * app's Node inspector (launched with `--inspect`), registers an ESM resolve
 * hook that converts Windows paths to `file://` URLs, and — as a fallback —
 * touches the extension entrypoint to trigger the host's auto-reload
 * re-import.
 *
 * Usage: node airi-loader-injector.mjs <extensionDir> <appUserDataDir>
 * e.g.:  node airi-loader-injector.mjs
 *          "C:\Users\you\AppData\Roaming\ai.moeru.airi\extensions\v1\airi-twitch-chat"
 *          "C:\Users\you\AppData\Roaming\ai.moeru.airi"
 *
 * Both arguments are required — no machine-specific defaults are baked in.
 */

import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const INSPECTOR_PORT = 9229

const HOOK_EXPRESSION = `(() => {
  const { pathToFileURL } = process.getBuiltinModule('node:url')
  const { registerHooks } = process.getBuiltinModule('node:module')
  if (typeof registerHooks !== 'function') {
    return { ok: false, reason: 'registerHooks unavailable' }
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (typeof specifier === 'string'
        && (/^[A-Za-z]:[\\\\/]/.test(specifier) || /^\\\\\\\\/.test(specifier))) {
        const [pathname, search = ''] = specifier.split('?')
        let url = pathToFileURL(pathname).href
        if (search) url += '?' + search
        return { url, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
  return { ok: true }
})()`

function log(...args) {
  console.info(`[airi-loader-injector]`, ...args)
}

async function waitForInspector(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json/list`)
      const targets = await response.json()
      const main = targets.find(target => target.type === 'node')
      if (main) {
        return main
      }
    }
    catch {
      // inspector not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`inspector did not appear within ${timeoutMs}ms`)
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('evaluate timed out')), 10000)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true },
      }))
    })
    ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.id === 1) {
        clearTimeout(timeout)
        resolve(message)
      }
    })
    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('websocket error'))
    })
  })
  ws.close()
  return result
}

function latestSessionLogHasExtensionLoadedAfter(userDataDir, markerTimestamp) {
  try {
    const logDir = join(userDataDir, 'logs')
    const files = readdirSync(logDir)
      .filter(name => name.startsWith('airi-tamagotchi-') && name.endsWith('.log'))
      .sort()
    if (files.length === 0) {
      return false
    }
    const latest = join(logDir, files[files.length - 1])
    if (statSync(latest).mtimeMs < markerTimestamp) {
      return false
    }
    const content = readFileSync(latest, 'utf8')
    return content.includes('extension loaded') && content.includes('airi-twitch-chat')
  }
  catch {
    return false
  }
}

async function main() {
  const extensionDir = process.argv[2]
  const userDataDir = process.argv[3]
  if (!extensionDir || !userDataDir) {
    console.error('[airi-loader-injector] usage: node airi-loader-injector.mjs <extensionDir> <userDataDir>')
    process.exit(1)
  }
  const entrypoint = join(extensionDir, 'index.mjs')

  log('waiting for inspector on port', INSPECTOR_PORT)
  const target = await waitForInspector(20000)
  log('attached to:', target.title)

  const hookResult = await evaluate(target.webSocketDebuggerUrl, HOOK_EXPRESSION)
  const hookValue = hookResult.result && hookResult.result.result && hookResult.result.result.value
  log('hook registration:', JSON.stringify(hookValue))
  if (!(hookValue && hookValue.ok)) {
    throw new Error('hook registration failed: ' + JSON.stringify(hookResult.result))
  }

  const markerTimestamp = Date.now()
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      appendFileSync(entrypoint, '\n')
    }
    catch {
      // entrypoint not writable; keep polling the log
    }
    await new Promise(resolve => setTimeout(resolve, 1500))
    if (latestSessionLogHasExtensionLoadedAfter(userDataDir, markerTimestamp)) {
      log(`extension confirmed loaded (attempt ${attempt})`)
      process.exit(0)
    }
  }

  console.error('[airi-loader-injector] extension did not confirm loading within 18s')
  process.exit(1)
}

main().catch(error => {
  console.error('[airi-loader-injector] fatal:', error.message)
  process.exit(1)
})
