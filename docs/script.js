// Realtime A5 Whiteboard (client, GitHub Pages friendly)
// Multi-user via WebSocket backend; server autosaves board per room.

const A5_ASPECT = 148 / 210;

// --- UI refs ---
const UI = {
  pageStage: document.getElementById('pageStage'),
  mobileDock: document.getElementById('mobileDock'),

  dockPen: document.getElementById('dockPen'),
  dockEraser: document.getElementById('dockEraser'),
  dockSizeMinus: document.getElementById('dockSizeMinus'),
  dockSizePlus: document.getElementById('dockSizePlus'),
  dockSizeLabel: document.getElementById('dockSizeLabel'),
  dockColor: document.getElementById('dockColor'),
  dockPageLabel: document.getElementById('dockPageLabel'),

  net: document.getElementById('netIndicator'),
};

// --- state ---
const state = {
  tool: 'pen',
  size: 8,
  color: '#111111',

  page: 0,
  pages: [],           // [{ canvas, ctx, dpr }]
  drawing: false,
  lastNorm: null,

  clientId: crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(36).slice(2)),
  roomId: new URLSearchParams(location.search).get('room') || 'main',
  ws: null,
};

// -- connect WebSocket (configurable base) --
function connectWS(){
  const base = (window.WS_BASE && window.WS_BASE.trim()) || (location.protocol + '//' + location.host);
  const proto = base.startsWith('https') ? 'wss' :
                base.startsWith('http')  ? 'ws'  :
                (location.protocol === 'https:' ? 'wss' : 'ws');
  const origin = base.replace(/^https?:/, ''); // remove scheme
  const url = `${proto}:${origin}/ws?room=${encodeURIComponent(state.roomId)}&id=${encodeURIComponent(state.clientId)}`;

  const ws = new WebSocket(url);
  state.ws = ws;
  setNet('Connecting…', 'net-warn');

  ws.onopen = () => setNet('Online', 'net-ok');
  ws.onclose = () => setNet('Offline', 'net-bad');
  ws.onerror = () => setNet('Error', 'net-bad');

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleWSMessage(msg);
    } catch (e) { console.error('Bad WS message', e); }
  };
}
function setNet(text, cls){ UI.net.textContent = text; UI.net.className = `net-indicator ${cls||''}`; }

// --- init ---
makePage(); selectPage(0);
wireDock(); addResizeObservers(); observeDock();
connectWS();

// --- dock ---
function wireDock(){
  UI.dockPen.addEventListener('click', () => setTool('pen'));
  UI.dockEraser.addEventListener('click', () => setTool('eraser'));
  UI.dockSizeMinus.addEventListener('click', () => setBrushSize(Math.max(1, state.size - 2)));
  UI.dockSizePlus.addEventListener('click', () => setBrushSize(Math.min(60, state.size + 2)));
  UI.dockColor.addEventListener('input', (e) => setPenColor(e.target.value));

  UI.dockSizeLabel.textContent = `${state.size}px`;
  setTool('pen');
}
function setTool(tool){
  state.tool = tool;
  const isPen = tool === 'pen';
  UI.dockPen.classList.toggle('active', isPen);
  UI.dockEraser.classList.toggle('active', !isPen);

  const p = getActivePage();
  if (p){
    p.ctx.globalCompositeOperation = isPen ? 'source-over' : 'destination-out';
    p.canvas.style.cursor = isPen ? 'crosshair' : 'cell';
  }
}
function setBrushSize(px){
  state.size = px|0;
  UI.dockSizeLabel.textContent = `${state.size}px`;
  const p = getActivePage();
  if (p) p.ctx.lineWidth = state.size;
}
function setPenColor(cssColor){
  // validate color
  const t = document.createElement('canvas').getContext('2d');
  try { t.strokeStyle = cssColor; } catch { return; }
  state.color = cssColor;
  if (state.color.startsWith('#')) UI.dockColor.value = state.color;
  const p = getActivePage();
  if (p && state.tool === 'pen') p.ctx.strokeStyle = state.color;
}

// --- page/canvas ---
function makePage(){
  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  canvas.setAttribute('role', 'tabpanel');
  UI.pageStage.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  const page = { canvas, ctx, dpr: 1 };
  state.pages.push(page);

  bindDrawingEvents(page);
  layoutPageToFit(page, false);
  UI.dockPageLabel.textContent = '1/1';
  return state.pages.length - 1;
}
function selectPage(idx){
  state.pages.forEach((p,i) => p.canvas.style.display = i===idx ? 'block' : 'none');
  state.page = idx;
  const p = getActivePage();
  p.ctx.lineWidth = state.size;
  p.ctx.strokeStyle = state.color;
  p.ctx.lineJoin = 'round';
  p.ctx.lineCap = 'round';
  p.ctx.globalCompositeOperation = state.tool === 'pen' ? 'source-over' : 'destination-out';
  layoutPageToFit(p, true);
}
function getActivePage(){ return state.pages[state.page]; }

// --- drawing (normalized coords) ---
function bindDrawingEvents(page){
  const c = page.canvas;

  const onDown = (e) => {
    e.preventDefault();
    c.setPointerCapture?.(e.pointerId);
    state.drawing = true;
    const norm = toNorm(c, e);
    state.lastNorm = norm;
    beginLocalStroke(norm);
  };
  const onMove = (e) => {
    if (!state.drawing) return;
    const norm = toNorm(c, e);
    drawLocalSegment(state.lastNorm, norm);
    sendSeg(state.lastNorm, norm);
    state.lastNorm = norm;
  };
  const onUp = (e) => {
    if (!state.drawing) return;
    const norm = toNorm(c, e);
    drawLocalSegment(state.lastNorm, norm);
    sendSeg(state.lastNorm, norm, true);
    state.drawing = false;
    state.lastNorm = null;
    c.releasePointerCapture?.(e.pointerId);
  };

  c.addEventListener('pointerdown', onDown);
  c.addEventListener('pointermove', onMove);
  c.addEventListener('pointerup', onUp);
  c.addEventListener('pointercancel', onUp);
  c.addEventListener('pointerleave', onUp);
}
function beginLocalStroke(norm){
  const p = getActivePage();
  p.ctx.beginPath();
  const { x, y } = fromNormToPx(p, norm);
  p.ctx.moveTo(x, y);
}
function drawLocalSegment(a, b){
  const p = getActivePage();
  p.ctx.lineWidth = state.size;
  if (state.tool === 'pen') p.ctx.strokeStyle = state.color;
  const B = fromNormToPx(p, b);
  p.ctx.lineTo(B.x, B.y);
  p.ctx.stroke();
}

function toNorm(canvas, e){
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
function fromNormToPx(page, norm){
  return {
    x: norm.x * page.canvas.width / page.dpr,
    y: norm.y * page.canvas.height / page.dpr
  };
}

// --- realtime messages ---
function sendSeg(a, b, end=false){
  if (!state.ws || state.ws.readyState !== 1) return;
  const msg = {
    type: 'seg',
    room: state.roomId,
    page: state.page,
    from: state.clientId,
    tool: state.tool,
    size: state.size,
    color: state.color,
    a, b, end
  };
  state.ws.send(JSON.stringify(msg));
}
function handleWSMessage(msg){
  if (msg.type === 'hello'){
    setNet('Online', 'net-ok');
    if (Array.isArray(msg.history)) replayHistory(msg.history);
    return;
  }
  if (msg.type === 'seg'){
    if (msg.from === state.clientId) return; // just in case
    drawRemoteSeg(msg);
  }
}
function drawRemoteSeg(evt){
  const p = getActivePage();
  const { ctx } = p;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = evt.size;
  if (evt.tool === 'pen') ctx.strokeStyle = evt.color;
  ctx.globalCompositeOperation = (evt.tool === 'pen') ? 'source-over' : 'destination-out';
  const A = fromNormToPx(p, evt.a);
  const B = fromNormToPx(p, evt.b);
  ctx.beginPath();
  ctx.moveTo(A.x, A.y);
  ctx.lineTo(B.x, B.y);
  ctx.stroke();
  ctx.restore();
}

// --- fit-to-screen (preserve strokes) ---
function addResizeObservers(){
  const ro = new ResizeObserver(() => layoutActivePage(true));
  ro.observe(UI.pageStage);
  window.addEventListener('resize', () => layoutActivePage(true));
  window.addEventListener('orientationchange', () => layoutActivePage(true));
}
function layoutActivePage(preserve=true){
  const p = getActivePage();
  layoutPageToFit(p, preserve);
}
function layoutPageToFit(page, preserve){
  const rect = UI.pageStage.getBoundingClientRect();
  const availW = Math.max(100, rect.width - 16);
  const availH = Math.max(100, rect.height - 16);

  let targetW = availW;
  let targetH = targetW / A5_ASPECT;
  if (targetH > availH) { targetH = availH; targetW = targetH * A5_ASPECT; }

  page.canvas.style.width = `${Math.floor(targetW)}px`;
  page.canvas.style.height = `${Math.floor(targetH)}px`;
  syncBufferToDisplay(page, preserve);
}
function syncBufferToDisplay(page, preserveContent){
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cssW = Math.floor(parseFloat(page.canvas.style.width));
  const cssH = Math.floor(parseFloat(page.canvas.style.height));
  const need = page.canvas.width !== Math.round(cssW * dpr) || page.canvas.height !== Math.round(cssH * dpr) || page.dpr !== dpr;
  if (!need) return;

  let snap = null;
  if (preserveContent){
    page.ctx.save(); page.ctx.setTransform(1,0,0,1,0,0);
    snap = page.ctx.getImageData(0,0,page.canvas.width, page.canvas.height);
    page.ctx.restore();
  }

  page.dpr = dpr;
  page.canvas.width = Math.round(cssW * dpr);
  page.canvas.height = Math.round(cssH * dpr);
  page.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  page.ctx.lineJoin = 'round';
  page.ctx.lineCap  = 'round';
  page.ctx.lineWidth = state.size;
  page.ctx.strokeStyle = state.color;
  page.ctx.globalCompositeOperation = state.tool === 'pen' ? 'source-over' : 'destination-out';

  if (snap){
    const temp = document.createElement('canvas');
    temp.width = snap.width; temp.height = snap.height;
    const tctx = temp.getContext('2d'); tctx.putImageData(snap, 0, 0);
    page.ctx.save(); page.ctx.setTransform(1,0,0,1,0,0);
    page.ctx.drawImage(temp, 0, 0, page.canvas.width, page.canvas.height);
    page.ctx.restore();
  }
}

// --- bottom toolbar spacing ---
function observeDock(){
  if (!UI.mobileDock) return;
  const ro = new ResizeObserver(syncDockPadding);
  ro.observe(UI.mobileDock);
  window.addEventListener('resize', syncDockPadding);
  window.addEventListener('orientationchange', () => setTimeout(syncDockPadding, 50));
  syncDockPadding();
}
function syncDockPadding(){
  const h = UI.mobileDock.getBoundingClientRect().height || 0;
  document.documentElement.style.setProperty('--dock-h', `${Math.ceil(h)}px`);
}

// --- history replay (on join/reconnect) ---
function replayHistory(history){
  const p = getActivePage();
  p.ctx.save(); p.ctx.setTransform(1,0,0,1,0,0);
  p.ctx.clearRect(0,0,p.canvas.width, p.canvas.height);
  p.ctx.restore();

  for (const evt of history){
    if (evt.type !== 'seg') continue;
    drawRemoteSeg(evt);
  }
}
