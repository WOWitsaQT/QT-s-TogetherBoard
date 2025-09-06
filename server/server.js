// Realtime whiteboard server (Node + Express + ws)
// Serves /ws (WebSocket). Keeps per-room history in memory and autosaves to ./export/<room>.json

import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const EXPORT_DIR = path.join(__dirname, 'export');
const rooms = new Map(); // roomId -> { history: [], lastSave: 0 }

// Simple health route (helpful for Render)
app.get('/healthz', (_, res) => res.send('ok'));

// Upgrade HTTP -> WS
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._roomId = url.searchParams.get('room') || 'main';
    ws._clientId = url.searchParams.get('id') || Math.random().toString(36).slice(2);
    wss.emit('connection', ws, req);
  });
});

// WebSocket handler
wss.on('connection', async (ws) => {
  const roomId = ws._roomId;
  if (!rooms.has(roomId)) rooms.set(roomId, { history: [], lastSave: 0 });
  await ensureRoomLoaded(roomId); // lazy-load history if exists

  const room = rooms.get(roomId);
  ws.send(JSON.stringify({ type: 'hello', history: room.history }));

  ws.on('message', async (data) => {
    try{
      const msg = JSON.parse(data.toString());
      if (!msg || msg.room !== roomId) return;
      if (msg.type === 'seg'){
        const evt = normalizeSeg(roomId, msg);
        room.history.push(evt);
        broadcastRoom(roomId, evt, ws);
        maybeSaveRoom(roomId);
      }
    }catch(e){ console.error('Bad message:', e); }
  });
});

function normalizeSeg(roomId, msg){
  return {
    type: 'seg',
    room: roomId,
    page: msg.page|0,
    from: msg.from || 'anon',
    tool: msg.tool === 'eraser' ? 'eraser' : 'pen',
    size: Math.max(1, Math.min(60, msg.size|0 || 8)),
    color: typeof msg.color === 'string' ? msg.color : '#111111',
    a: clampPt(msg.a), b: clampPt(msg.b),
    end: !!msg.end,
    ts: Date.now()
  };
}
function clampPt(pt){
  if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') return { x:0, y:0 };
  return { x: Math.max(0, Math.min(1, pt.x)), y: Math.max(0, Math.min(1, pt.y)) };
}
function broadcastRoom(roomId, msg, exceptWs){
  const payload = JSON.stringify(msg);
  for (const client of wss.clients){
    if (client.readyState !== 1) continue;
    if (client._roomId !== roomId) continue;
    if (client === exceptWs) continue;
    client.send(payload);
  }
}
async function ensureRoomLoaded(roomId){
  const room = rooms.get(roomId);
  const file = path.join(EXPORT_DIR, `${safe(roomId)}.json`);
  try{
    await fs.mkdir(EXPORT_DIR, { recursive: true });
    if (room.history.length === 0) {
      const buf = await fs.readFile(file);
      const saved = JSON.parse(buf.toString());
      if (Array.isArray(saved.history)) room.history = saved.history;
    }
  }catch{ /* fine if file missing */ }
}
async function maybeSaveRoom(roomId){
  const now = Date.now();
  const room = rooms.get(roomId);
  if (!room) return;
  if (now - room.lastSave < 2000) return; // debounce: max every 2s
  room.lastSave = now;

  const file = path.join(EXPORT_DIR, `${safe(roomId)}.json`);
  const data = JSON.stringify({ room: roomId, savedAt: new Date().toISOString(), history: room.history });
  try{
    await fs.mkdir(EXPORT_DIR, { recursive: true });
    await fs.writeFile(file, data);
  }catch(e){ console.error('Save error:', e); }
}
function safe(s){ return String(s).replace(/[^a-z0-9_\-]/gi, '_'); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WS server on :${PORT}  (health: /healthz)`);
  console.log(`Remember to set docs/config.js -> window.WS_BASE to your backend URL.`);
});
