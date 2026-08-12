// Process-engine worker: runs in its own child process, loads route modules and
// executes them against per-request sandboxes, communicating over IPC.
const path = require('path')
const fs = require('fs')
const { createHash } = require('crypto')
const { pathToFileURL } = require('url')

// undici is the same HTTP client Node's native fetch is built on. We pull in
// its Agent here only to support the non-standard per-call `insecure: true`
// fetch init (skip TLS cert verification on a single outbound request). All
// other standard RequestInit fields (method/headers/body/redirect/compress/
// signal/duplex/...) are honored by Node's native fetch itself.
let makeInsecureDispatcher = () => null
try {
  const { Agent: UndiciAgent } = require('undici')
  if (UndiciAgent) makeInsecureDispatcher = () => new UndiciAgent({ connect: { rejectUnauthorized: false } })
} catch {}

// Wrap the runtime fetch so a route can opt out of TLS verification per call
// via `fetch(url, { insecure: true })` (mirrors the isolatedvm engine). When
// the flag is absent, native fetch runs unchanged with full TLS verification.
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (url, init) => {
  init = init || {}
  const wantInsecure = init.insecure === true
    || init.rejectUnauthorized === false
    || (init.tls && init.tls.rejectUnauthorized === false)
  if (wantInsecure && makeInsecureDispatcher) {
    const { insecure: _insecure, rejectUnauthorized: _reject, tls: _tls, ...rest } = init
    rest.dispatcher = makeInsecureDispatcher()
    return nativeFetch(url, rest)
  }
  return nativeFetch(url, init)
}

const scriptsDir = process.argv[2]
const modulesDir = process.argv[3]
const allowFs = process.argv[4] === 'true'

// module-cache: key = routeId:hash, value = loaded module namespace
const moduleCache = new Map()

process.on('message', async (msg) => {
  if (!msg || !msg.type) return
  try {
    if (msg.type === 'warm') {
      await loadModule(msg.routeId, msg.hash, msg.source)
      process.send({ type: 'ready', id: msg.id })
    } else if (msg.type === 'execute') {
      const result = await execute(msg)
      process.send({ type: 'result', id: msg.id, result })
    }
  } catch (err) {
    process.send({ type: 'error', id: msg.id, error: String((err && err.stack) || err) })
  }
})

async function loadModule(routeId, hash, source) {
  const key = `${routeId}:${hash}`
  if (moduleCache.has(key)) return moduleCache.get(key)
  fs.mkdirSync(scriptsDir, { recursive: true })
  const safe = String(routeId).replace(/[^a-zA-Z0-9_-]/g, '_')
  const file = path.join(scriptsDir, `__route_${safe}_${hash}.mjs`)
  if (!fs.existsSync(file)) fs.writeFileSync(file, source, 'utf-8')
  const module = await import(pathToFileURL(file).href)
  moduleCache.set(key, module)
  return module
}

async function execute(msg) {
  const start = Date.now()
  const module = await loadModule(msg.routeId, msg.hash, msg.source)
  const capturedLogs = []
  const customConsole = {
    log: (...args) => capturedLogs.push(`[LOG] ${stringifyArgs(args)}`),
    warn: (...args) => capturedLogs.push(`[WARN] ${stringifyArgs(args)}`),
    error: (...args) => capturedLogs.push(`[ERROR] ${stringifyArgs(args)}`),
    info: (...args) => capturedLogs.push(`[INFO] ${stringifyArgs(args)}`)
  }

  let responseStatus = 200
  let responseHeaders = { 'Content-Type': 'application/json' }
  let responseBody = null
  let responseSent = false

  const mockResponse = {
    status: (code) => { responseStatus = code; return mockResponse },
    setHeader: (key, value) => { responseHeaders[key] = value; return mockResponse },
    json: (data) => {
      responseHeaders['Content-Type'] = 'application/json'
      responseBody = JSON.stringify(data, null, 2)
      responseSent = true
      return mockResponse
    },
    send: (data) => {
      if (typeof data === 'object') {
        responseHeaders['Content-Type'] = 'application/json'
        responseBody = JSON.stringify(data, null, 2)
      } else {
        if (!responseHeaders['Content-Type']) responseHeaders['Content-Type'] = 'text/plain; charset=utf-8'
        responseBody = String(data)
      }
      responseSent = true
      return mockResponse
    },
    redirect: (url) => {
      responseStatus = 302
      responseHeaders['Location'] = url
      responseBody = `Redirecting to ${url}`
      responseSent = true
      return mockResponse
    }
  }

  try {
    const sandbox = {
      request: msg.request,
      response: mockResponse,
      fetch: globalThis.fetch,
      console: customConsole,
      ...(allowFs ? { fs } : {})
    }
    await module.default(sandbox)
    if (!responseSent && responseBody === null) {
      responseBody = JSON.stringify({ message: 'Route executed successfully (No response payload explicitly sent)' })
    }
    return {
      statusCode: responseStatus,
      headers: responseHeaders,
      body: responseBody,
      logs: capturedLogs,
      durationMs: Date.now() - start
    }
  } catch (err) {
    customConsole.error(`Route Script Exception caught: ${err.message}`)
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Script Execution Exception Isolated',
        routeId: msg.routeId,
        message: err.message,
        stack: err.stack
      }, null, 2),
      logs: capturedLogs,
      error: err.message,
      stack: err.stack,
      durationMs: Date.now() - start
    }
  }
}

function stringifyArgs(args) {
  return Array.from(args).map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
}