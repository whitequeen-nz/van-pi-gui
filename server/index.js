/**
 * van-pi-gui server
 * Bridges browser <-> omp RPC via WebSocket.
 * No external dependencies beyond 'ws' (already in package.json).
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { WebSocketServer } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 7302)
const OMP_BIN = process.env.OMP_BIN || '/root/.bun/bin/omp'
const OMP_MODEL = process.env.OMP_MODEL || 'qwen2.5-coder:7b'
const OMP_CWD = process.env.OMP_CWD || '/opt/van-pi-harness'
const CLIENT_DIR = join(__dirname, '../client/dist')
const ARCHIVE_DIR = '/opt/van-pi-gui/archive'

// Ensure archive dir exists
mkdirSync(ARCHIVE_DIR, { recursive: true })

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

const OMP_ENV = {
  ...process.env,
  PATH: `/root/.bun/bin:${process.env.PATH || '/usr/bin:/bin'}`,
  HOME: '/root',
  TERM: 'dumb',
}

// ── Static file server ─────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function serveStatic(req, res) {
  const url = req.url.split('?')[0]
  const safePath = url === '/' ? '/index.html' : url
  const filePath = join(CLIENT_DIR, safePath)

  // Prevent path traversal
  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return
  }

  if (existsSync(filePath)) {
    const ext = extname(filePath)
    const mime = MIME[ext] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime })
    res.end(readFileSync(filePath))
  } else {
    // SPA fallback
    const idx = join(CLIENT_DIR, 'index.html')
    if (existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(readFileSync(idx))
    } else {
      res.writeHead(404); res.end('Not found')
    }
  }
}

// ── HTTP server ────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // Archive endpoint
  if (req.method === 'POST' && req.url === '/archive') {
    try {
      const body = await readBody(req)
      const { messages } = JSON.parse(body)
      if (Array.isArray(messages) && messages.length) {
        const date = new Date().toISOString().slice(0, 10)
        const file = join(ARCHIVE_DIR, `chat-${date}.jsonl`)
        const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
        appendFileSync(file, lines, 'utf8')
        console.log(`[van-pi-gui] Archived ${messages.length} messages → ${file}`)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    } catch (e) {
      res.writeHead(400); res.end('bad request')
    }
    return
  }
  serveStatic(req, res)
})
const wss = new WebSocketServer({ server })

// ── WebSocket bridge ───────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress
  console.log(`[van-pi-gui] Client connected from ${ip}`)

  const proc = spawn(OMP_BIN, ['--model', OMP_MODEL, '--mode', 'rpc', '--cwd', OMP_CWD], {
    cwd: OMP_CWD,
    env: OMP_ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let lineBuffer = ''

  proc.stdout.on('data', (chunk) => {
    lineBuffer += chunk.toString()
    const lines = lineBuffer.split('\n')
    lineBuffer = lines.pop()
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (ws.readyState === ws.OPEN) ws.send(trimmed)
    }
  })

  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim()
    if (msg && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'server_log', level: 'stderr', message: msg }))
    }
  })

  proc.on('exit', (code) => {
    console.log(`[van-pi-gui] omp exited: ${code}`)
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'server_log', level: 'info', message: `omp exited (code ${code})` }))
      ws.close()
    }
  })

  proc.on('error', (err) => {
    console.error(`[van-pi-gui] spawn error: ${err.message}`)
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'server_log', level: 'error', message: `omp failed to start: ${err.message}` }))
      ws.close()
    }
  })

  ws.on('message', (data) => {
    const text = data.toString()
    try {
      JSON.parse(text) // validate JSON
      if (proc.stdin.writable) proc.stdin.write(text + '\n')
    } catch {
      ws.send(JSON.stringify({ type: 'server_log', level: 'error', message: 'Invalid JSON command' }))
    }
  })

  ws.on('close', () => {
    console.log('[van-pi-gui] Client disconnected')
    if (!proc.killed) proc.kill()
  })

  ws.on('error', (err) => {
    console.error(`[van-pi-gui] WS error: ${err.message}`)
    if (!proc.killed) proc.kill()
  })

  // Ready signal
  ws.send(JSON.stringify({ type: 'server_log', level: 'info', message: `omp starting (model: ${OMP_MODEL})…` }))
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[van-pi-gui] Listening on http://0.0.0.0:${PORT}`)
})
