/**
 * van-pi-gui server
 * Bridges browser <-> omp RPC via WebSocket.
 * No external dependencies beyond 'ws' (already in package.json).
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname, relative } from 'node:path'
import { WebSocketServer } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 7302)
const OMP_BIN = process.env.OMP_BIN || '/root/.bun/bin/omp'
const OMP_MODEL = process.env.OMP_MODEL || 'qwen2.5-coder:7b'
const OMP_CWD = process.env.OMP_CWD || '/opt/van-pi-harness'
const CLIENT_DIR = join(__dirname, '../client/dist')
const ARCHIVE_DIR = '/opt/van-pi-gui/archive'
const SITES_DIR = '/opt/van-pi-gui/test-sites'

// Ensure dirs exist
mkdirSync(ARCHIVE_DIR, { recursive: true })
mkdirSync(SITES_DIR, { recursive: true })

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

// ── Sites directory listing + file serving ─────────────────────────────────
function buildDirListing(dirPath, urlPath) {
  let entries
  try { entries = readdirSync(dirPath) } catch { return null }

  const rows = entries.map(name => {
    const full = join(dirPath, name)
    let stat
    try { stat = statSync(full) } catch { return '' }
    const isDir = stat.isDirectory()
    const href = urlPath.replace(/\/?$/, '/') + name + (isDir ? '/' : '')
    const icon = isDir ? '📁' : name.endsWith('.html') ? '🌐' : '📄'
    const size = isDir ? '—' : `${(stat.size / 1024).toFixed(1)} KB`
    return `<tr><td>${icon} <a href="${href}">${name}${isDir ? '/' : ''}</a></td><td>${size}</td></tr>`
  }).join('\n')

  const rel = urlPath.replace(/^\/sites/, '') || '/'
  const parent = urlPath !== '/sites' && urlPath !== '/sites/'
    ? `<tr><td>⬆ <a href="../">../</a></td><td>—</td></tr>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>van-pi sites${rel}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0d0f14; color: #e2e4ef; padding: 40px; }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
    p { font-size: 13px; color: #6b6f85; margin-bottom: 24px; font-family: monospace; }
    table { border-collapse: collapse; width: 100%; max-width: 700px; }
    tr { border-bottom: 1px solid #252836; }
    td { padding: 10px 14px; font-size: 14px; }
    td:last-child { color: #6b6f85; font-family: monospace; font-size: 12px; text-align: right; }
    a { color: #7c6af7; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .back { display: inline-block; margin-top: 28px; font-size: 13px; color: #6b6f85; }
    .back a { color: #6b6f85; }
  </style>
</head>
<body>
  <h1>🖥 van-pi · sites</h1>
  <p>${urlPath}</p>
  <table>
    ${parent}
    ${rows}
  </table>
  <div class="back"><a href="/sites/">↑ root</a> · <a href="/">← GUI</a></div>
</body>
</html>`
}

function serveSites(req, res, urlPath) {
  // Strip /sites prefix to get relative path
  const rel = urlPath.replace(/^\/sites/, '') || '/'
  const target = join(SITES_DIR, rel)

  // Path traversal guard
  if (!target.startsWith(SITES_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return
  }

  if (!existsSync(target)) {
    res.writeHead(404, { 'Content-Type': 'text/html' })
    res.end(`<body style="background:#0d0f14;color:#e2e4ef;font-family:system-ui;padding:40px">
      <h2>Not found</h2><p>${rel}</p><a href="/sites/" style="color:#7c6af7">← back to sites</a></body>`)
    return
  }

  const stat = statSync(target)
  if (stat.isDirectory()) {
    // Check for index.html first
    const idx = join(target, 'index.html')
    if (existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(readFileSync(idx))
      return
    }
    const html = buildDirListing(target, urlPath)
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
    return
  }

  const mime = MIME[extname(target)] || 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': mime })
  res.end(readFileSync(target))
}


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
  const urlPath = req.url.split('?')[0]

  // Sites browser
  if (urlPath === '/sites' || urlPath.startsWith('/sites/')) {
    serveSites(req, res, urlPath)
    return
  }

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
