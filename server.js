require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3456;
const JWT_SECRET = process.env.JWT_SECRET || 'cue-studio-dev-secret-change-in-prod';

// Use Railway volume for persistent storage when available
const DATA_DIR = process.env.RAILWAY_VOLUME_PATH || __dirname;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_DIR = path.join(DATA_DIR, 'db');
const DB_PATH = path.join(DB_DIR, 'studio.db');

// Ensure directories exist
[UPLOAD_DIR, DB_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

let db;
const liveStreams = {}; // id -> { session, chunks: [{index, data}], sseClients: [res], startTime, active }
const liveChat = {}; // id -> [{index, name, message, timestamp}]

async function initDb() {
  const SQL = await initSqlJs();
  try {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } catch {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    duration_seconds INTEGER DEFAULT 0,
    lesson_id TEXT,
    youtube_video_id TEXT,
    youtube_status TEXT DEFAULT 'none',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS live_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    lesson_id TEXT NOT NULL,
    room_name TEXT,
    stream_key TEXT,
    status TEXT DEFAULT 'ended',
    started_at TEXT,
    ended_at TEXT
  )`);
  try { db.run("ALTER TABLE live_sessions ADD COLUMN stream_key TEXT"); } catch {}

  const defaultAdmin = process.env.ADMIN_EMAIL || 'admin@cuestudio.dev';
  const defaultPass = process.env.ADMIN_PASSWORD || 'admin123';
  const existing = db.exec(`SELECT id FROM users WHERE email = '${defaultAdmin.replace(/'/g, "''")}'`);
  if (!existing.length || !existing[0].values.length) {
    const hash = bcrypt.hashSync(defaultPass, 10);
    db.run(`INSERT INTO users (id, email, name, password, is_admin) VALUES ('${uuidv4()}', '${defaultAdmin.replace(/'/g, "''")}', 'Admin', '${hash.replace(/'/g, "''")}', 1)`);
    console.log('Created default admin:', defaultAdmin);
  }
  saveDb();
}

function saveDb() {
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (e) { console.error('DB save error:', e); }
}

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// ── Middleware ──
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname) || '.webm'}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'missing_token' });
  try {
    req.user = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}

// ── Auth routes ──
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
  const users = query(`SELECT * FROM users WHERE email = ?`, [email.toLowerCase().trim()]);
  if (!users.length || !bcrypt.compareSync(password, users[0].password)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const u = users[0];
  const token = jwt.sign({ id: u.id, email: u.email, name: u.name, isAdmin: !!u.is_admin }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: u.id, email: u.email, name: u.name, isAdmin: !!u.is_admin } });
});

app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'missing_fields' });
  const existing = query(`SELECT id FROM users WHERE email = ?`, [email.toLowerCase().trim()]);
  if (existing.length) return res.status(409).json({ error: 'email_exists' });
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  run(`INSERT INTO users (id, email, name, password) VALUES (?, ?, ?, ?)`, [id, email.toLowerCase().trim(), name.trim(), hash]);
  const token = jwt.sign({ id, email, name, isAdmin: false }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id, email, name, isAdmin: false } });
});

// ── Recording routes ──
app.post('/api/recordings/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const id = uuidv4();
  const lessonId = req.body.lesson_id || null;
  const duration = parseInt(req.body.duration || '0', 10);
  run(`INSERT INTO recordings (id, user_id, file_name, file_path, file_size, duration_seconds, lesson_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, req.user.id, req.file.filename, req.file.path, req.file.size, duration, lessonId]);
  res.json({ id, fileName: req.file.filename, size: req.file.size });
});

app.get('/api/recordings', auth, (req, res) => {
  const recs = query(`SELECT * FROM recordings WHERE user_id = ? ORDER BY created_at DESC`, [req.user.id]);
  res.json(recs.map(r => ({
    id: r.id,
    fileName: r.file_name,
    filePath: r.file_path,
    size: r.file_size,
    durationSeconds: r.duration_seconds,
    lessonId: r.lesson_id,
    youtubeVideoId: r.youtube_video_id,
    youtubeStatus: r.youtube_status,
    createdAt: r.created_at,
  })));
});

app.get('/api/recordings/:id/download', auth, (req, res) => {
  const recs = query(`SELECT * FROM recordings WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
  if (!recs.length) return res.status(404).json({ error: 'not_found' });
  res.sendFile(recs[0].file_path);
});

app.delete('/api/recordings/:id', auth, (req, res) => {
  const recs = query(`SELECT * FROM recordings WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
  if (!recs.length) return res.status(404).json({ error: 'not_found' });
  try { fs.unlinkSync(recs[0].file_path); } catch {}
  run(`DELETE FROM recordings WHERE id = ?`, [req.params.id]);
  res.json({ success: true });
});

// ── Disk/storage stats ──
app.get('/api/stats', auth, (req, res) => {
  const rows = query(`SELECT COALESCE(SUM(file_size), 0) as total_size, COUNT(*) as count FROM recordings WHERE user_id = ?`, [req.user.id]);
  const quotaBytes = (parseFloat(process.env.QUOTA_GB) || 10) * 1e9;
  const usedBytes = rows[0]?.total_size || 0;
  res.json({
    totalRecordings: rows[0]?.count || 0,
    usedBytes: Number(usedBytes),
    quotaBytes,
    freeBytes: quotaBytes - Number(usedBytes),
    usagePercent: quotaBytes > 0 ? Math.round((Number(usedBytes) / quotaBytes) * 100) : 0,
  });
});

// ── Health check (no auth) ──
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Live session routes ──
app.post('/api/live/start', auth, (req, res) => {
  const { lesson_id } = req.body;
  const id = uuidv4();
  const roomName = 'live-' + id.slice(0, 8);
  const streamKey = uuidv4();
  run(`INSERT INTO live_sessions (id, user_id, lesson_id, room_name, stream_key, status, started_at) VALUES (?, ?, ?, ?, ?, 'live', datetime('now'))`,
    [id, req.user.id, lesson_id || 'general', roomName, streamKey]);
  liveStreams[id] = { session: null, chunks: [], sseClients: [], startTime: Date.now(), active: true, chunkIndex: 0 };
  res.json({ id, roomName, streamKey, viewerUrl: `/live/${roomName}`, createdAt: new Date().toISOString() });
});

app.post('/api/live/stop', auth, (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'missing_id' });
  const sessions = query(`SELECT * FROM live_sessions WHERE id = ? AND user_id = ?`, [id, req.user.id]);
  if (!sessions.length) return res.status(404).json({ error: 'not_found' });
  run(`UPDATE live_sessions SET status = 'ended', ended_at = datetime('now') WHERE id = ?`, [id]);
  const stream = liveStreams[id];
  if (stream) {
    stream.active = false;
    stream.sseClients.forEach(c => { try { c.end(); } catch {} });
    delete liveStreams[id];
  }
  res.json({ success: true });
});

app.get('/api/live/active', auth, (req, res) => {
  const sessions = query(`SELECT * FROM live_sessions WHERE user_id = ? AND status = 'live' ORDER BY started_at DESC`, [req.user.id]);
  res.json(sessions.map(s => ({
    id: s.id, roomName: s.room_name, lessonId: s.lesson_id,
    status: s.status, startedAt: s.started_at, viewerUrl: `/live/${s.room_name}`,
  })));
});

app.post('/api/live/push/:id', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  const stream = liveStreams[req.params.id];
  if (!stream || !stream.active) return res.status(404).json({ error: 'stream_not_found' });
  const key = req.query.key || req.headers['x-stream-key'];
  const sessions = query(`SELECT * FROM live_sessions WHERE id = ?`, [req.params.id]);
  if (!sessions.length || sessions[0].stream_key !== key) return res.status(403).json({ error: 'invalid_key' });
  const index = stream.chunkIndex++;
  const data = req.body; // raw buffer
  stream.chunks.push({ index, data });
  // Keep last 500 chunks in memory
  if (stream.chunkIndex > 600) stream.chunks = stream.chunks.slice(-500);
  // Notify SSE clients
  stream.sseClients.forEach(c => {
    try { c.write(`data: ${JSON.stringify({ index, size: data.length })}\n\n`); } catch {}
  });
  stream.sseClients = stream.sseClients.filter(c => { try { return !c.destroyed; } catch { return false; } });
  res.json({ index });
});

app.get('/api/live/poll/:id', (req, res) => {
  const stream = liveStreams[req.params.id];
  if (!stream) return res.status(404).json({ error: 'stream_not_found' });
  const since = parseInt(req.query.since) || -1;
  const chunks = stream.chunks.filter(c => c.index > since).map(c => ({
    index: c.index, data: c.data.toString('base64'),
  }));
  const ended = !stream.active;
  res.json({ chunks, ended, active: stream.active, chunkIndex: stream.chunkIndex });
});

// ── Live chat ──
app.post('/api/live/chat/:id', (req, res) => {
  const stream = liveStreams[req.params.id];
  if (!stream) return res.status(404).json({ error: 'stream_not_found' });
  const { name, message } = req.body;
  if (!message) return res.status(400).json({ error: 'missing_message' });
  if (!liveChat[req.params.id]) liveChat[req.params.id] = [];
  const chat = liveChat[req.params.id];
  const msg = { index: chat.length, name: name || 'Anonymous', message, timestamp: Date.now() };
  chat.push(msg);
  if (chat.length > 200) chat.splice(0, chat.length - 200);
  stream.sseClients.forEach(c => {
    try { c.write(`data: ${JSON.stringify({ type: 'chat', chat: msg })}\n\n`); } catch {}
  });
  res.json(msg);
});

app.get('/api/live/chat/:id', (req, res) => {
  const stream = liveStreams[req.params.id];
  if (!stream) return res.status(404).json({ error: 'stream_not_found' });
  const since = parseInt(req.query.since) || -1;
  const chat = liveChat[req.params.id] || [];
  res.json({ messages: chat.filter(m => m.index > since), ended: !stream.active, active: stream.active });
});

app.get('/api/live/stream/:id', (req, res) => {
  const stream = liveStreams[req.params.id];
  if (!stream) return res.status(404).json({ error: 'stream_not_found' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', chunkIndex: stream.chunkIndex })}\n\n`);
  stream.sseClients.push(res);
  req.on('close', () => {
    stream.sseClients = stream.sseClients.filter(c => c !== res);
  });
});

// ── Live viewer page ──
app.get('/live/:roomName', (req, res) => {
  const sessions = query(`SELECT * FROM live_sessions WHERE room_name = ?`, [req.params.roomName]);
  if (!sessions.length) return res.status(404).send('Live session not found');
  const s = sessions[0];
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live - ${s.room_name}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0e14;color:#e0e0e0;font-family:system-ui;display:flex;flex-direction:column;height:100vh}
  .status-bar{display:flex;align-items:center;gap:12px;padding:10px 16px;background:#141a24;border-bottom:1px solid #2a2f3a;font-size:13px}
  .dot{width:10px;height:10px;border-radius:50%;background:#666}
  .dot.live{background:#ff4444;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .room{font-family:monospace;color:#888}
  .layout{display:flex;flex:1;overflow:hidden}
  .viewer-wrap{flex:1;display:flex;align-items:center;justify-content:center;padding:16px;position:relative}
  video{max-width:100%;max-height:100%;border-radius:4px;background:#000}
  .offline{text-align:center;color:#666}
  .offline h2{margin-bottom:8px}
  .chat-panel{width:320px;display:flex;flex-direction:column;border-left:1px solid #2a2f3a;background:#141a24}
  .chat-header{padding:10px 14px;font-size:13px;font-weight:600;border-bottom:1px solid #2a2f3a;color:#aaa}
  .chat-msgs{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:4px}
  .chat-msg{font-size:13px;padding:4px 8px;border-radius:4px;background:#1e2532;word-break:break-word}
  .chat-msg .name{color:#00e0ff;font-weight:600;font-size:11px}
  .chat-msg .text{color:#e0e0e0}
  .chat-input-wrap{display:flex;border-top:1px solid #2a2f3a;padding:8px}
  .chat-input-wrap input{flex:1;background:#1e2532;border:1px solid #2a2f3a;border-radius:4px;padding:8px;color:#e0e0e0;font-size:13px;outline:none}
  .chat-input-wrap input:focus{border-color:#00e0ff}
  .chat-input-wrap button{margin-left:6px;background:#00e0ff;border:none;border-radius:4px;padding:8px 12px;color:#0a0e14;font-weight:600;cursor:pointer;font-size:13px}
  .talk-btn{position:absolute;bottom:24px;right:24px;background:#c6ff00;border:none;border-radius:50%;width:56px;height:56px;cursor:pointer;font-size:13px;font-weight:700;color:#0a0e14;box-shadow:0 2px 12px rgba(0,0,0,.5);z-index:10}
  .talk-btn.active{background:#ff4444;animation:pulse 1s infinite}
</style>
</head>
<body>
<div class="status-bar">
  <span class="dot" id="dot"></span>
  <span id="status-text">Connecting...</span>
  <span class="room">${s.room_name}</span>
</div>
<div class="layout">
<div class="viewer-wrap">
  <video id="viewer-video" autoplay muted controls style="display:none"></video>
  <div class="offline" id="offline-msg">
    <h2>📡 Waiting for stream...</h2>
    <p>The streamer hasn't started sending yet.</p>
  </div>
</div>
<div class="chat-panel">
  <div class="chat-header">💬 Chat</div>
  <div class="chat-msgs" id="chat-msgs"></div>
  <div class="chat-input-wrap">
    <input id="chat-input" placeholder="Type a message..." onkeydown="if(event.key==='Enter')sendChat()" />
    <button onclick="sendChat()">Send</button>
  </div>
</div>
</div>
<script>
const sessionId = '${s.id}';
const video = document.getElementById('viewer-video');
const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const offlineMsg = document.getElementById('offline-msg');
const chatMsgs = document.getElementById('chat-msgs');
let allChunks = [];
let lastIndex = -1;
let chatIndex = -1;
let ended = false;
let streamActive = true;
let viewerName = 'Viewer_' + Math.random().toString(36).slice(2,6);

async function poll() {
  try {
    const r = await fetch('/api/live/poll/' + sessionId + '?since=' + lastIndex);
    const data = await r.json();
    ended = data.ended;
    streamActive = data.active;
    if (data.chunks && data.chunks.length) {
      for (const c of data.chunks) {
        const binary = atob(c.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        allChunks.push(bytes);
        lastIndex = c.index;
      }
      const blob = new Blob(allChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const wasPlaying = !video.paused;
      video.src = url;
      video.style.display = '';
      offlineMsg.style.display = 'none';
      if (wasPlaying) video.play().catch(() => {});
      dot.className = 'dot live';
      statusText.textContent = 'LIVE';
    }
    if (ended && !streamActive && !data.chunks?.length) {
      dot.className = 'dot';
      statusText.textContent = 'Stream ended';
    }
  } catch {}
  if (!ended) setTimeout(poll, 1500);
}
poll();

async function pollChat() {
  try {
    const r = await fetch('/api/live/chat/' + sessionId + '?since=' + chatIndex);
    const data = await r.json();
    if (data.messages && data.messages.length) {
      for (const m of data.messages) {
        chatIndex = m.index;
        const el = document.createElement('div');
        el.className = 'chat-msg';
        el.innerHTML = '<div class="name">' + esc(m.name) + '</div><div class="text">' + esc(m.message) + '</div>';
        chatMsgs.appendChild(el);
        chatMsgs.scrollTop = chatMsgs.scrollHeight;
      }
    }
  } catch {}
  setTimeout(pollChat, 1000);
}
pollChat();

async function sendChat() {
  const inp = document.getElementById('chat-input');
  const msg = inp.value.trim();
  if (!msg) return;
  inp.value = '';
  try {
    await fetch('/api/live/chat/' + sessionId, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name: viewerName, message: msg })
    });
  } catch {}
}
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
</script>
</body>
</html>`);
});

// ── YouTube upload route (placeholder for Phase 2) ──
app.post('/api/youtube/upload', auth, (req, res) => {
  res.json({ error: 'not_implemented_yet', message: 'YouTube upload coming in Phase 2' });
});

app.get('/api/youtube/auth-url', auth, (req, res) => {
  res.json({ error: 'not_implemented_yet' });
});

// ── Serve the studio frontend ──
app.get('/studio', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ──
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Cue Studio Web running at http://localhost:${PORT}`);
    console.log(`Studio UI at http://localhost:${PORT}/studio`);
    const defaultAdmin = process.env.ADMIN_EMAIL || 'admin@cuestudio.dev';
    const defaultPass = process.env.ADMIN_PASSWORD || 'admin123';
    console.log(`Default admin: ${defaultAdmin} / ${defaultPass}`);
  });
});
