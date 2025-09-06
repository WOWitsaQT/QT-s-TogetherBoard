// Realtime whiteboard server (Node + Express + ws), with page sync
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
const rooms = new Map(); // roomId -> { history: [], pageCount: number, lastSave: number }

app.get('/healthz', (_, res) => res.send('ok'));

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._roomId = url.searchParams.get('room') || 'main';
    ws._clientId = url.searchParams.get('id') || Math.random().toString(36).slice(2);
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', async (ws) => {
  const roomId = ws._roomId;
  if (!rooms.has(roomId)) rooms.set(roomId, { history: [], pageCount: 1, lastSave: 0 });
  await ensureRoomLoaded(roomId);

  const room = rooms.get(roomId);
  ws.send(JSON.stringify({ type: 'hello', pageCount: room.pageCount, history: room.history }));

  ws.on('message', async (data) => {
    try{
      const msg = JSON.parse(data.toString());
      if (!msg || msg.room !== roomId) return;
      if (msg.type === 'seg'){
        const evt = normalizeSeg(roomId, msg);
        room.history.push(evt);
        room.pageCount = Math.max(room.pageCount, (evt.page|0) + 1);
        broadcast(roomId, evt, ws);
        maybeSaveRoom(roomId);
      } else if (msg.type === 'pageinfo'){
        const count = Number(msg.count) || 1;
        if (count > room.pageCount){
          room.pageCount = count;
          const info = { type: 'pageinfo', room: roomId, count: room.pageCount, ts: Date.now() };
          broadcast(roomId, info, null);
          maybeSaveRoom(roomId);
        }
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
function broadcast(roomId, msg, exceptWs){
  const payload = JSON.stringify(msg);
  for (const client of wss.clients){
    if (client.readyState !== 1) continue;
    if (client._roomId !== roomId) continue;
    if (exceptWs && client === exceptWs) continue;
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
      if (Number.isInteger(saved.pageCount)) room.pageCount = Math.max(1, saved.pageCount);
    }
  }catch{ /* ok if missing */ }
}
async function maybeSaveRoom(roomId){
  const now = Date.now();
  const room = rooms.get(roomId);
  if (!room) return;
  if (now - room.lastSave < 2000) return;
  room.lastSave = now;

  const file = path.join(EXPORT_DIR, `${safe(roomId)}.json`);
  const data = JSON.stringify({
    room: roomId,
    pageCount: room.pageCount,
    savedAt: new Date().toISOString(),
    history: room.history
  });
  try{
    await fs.mkdir(EXPORT_DIR, { recursive: true });
    await fs.writeFile(file, data);
  }catch(e){ console.error('Save error:', e); }
}
function safe(s){ return String(s).replace(/[^a-z0-9_\-]/gi, '_'); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WS server on :${PORT}  (health: /healthz)`);
});
