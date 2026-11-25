import { PUBLIC_NODES, MODES, measureConnection } from './measure.js';

const el = id => document.getElementById(id);
const action = el('test-action');
const status = el('run-status');
const note = el('test-note');
const nodeSelect = el('node-select');
const dial = el('dial');
const chart = el('chart');
const colors = { down: '#c0f87a', up: '#c3afff' };
const phaseNames = { latency: '测量延迟', down: '测量下载', up: '测量上传' };
const keys = { down: 'down-value', up: 'up-value', latency: 'latency-value', jitter: 'jitter-value' };
const storeKey = 'netpulse.history.v1';
const localNode = document.querySelector('meta[name="netpulse-local-node"]').content === 'on';
const staticNode = { id: 'static', label: '网页节点', type: 'static', base: new URL('./', location.href).href };
const selfNode = { id: 'self', label: '本站', type: 'bytes', base: location.origin };
const nodesById = new Map([...PUBLIC_NODES, staticNode, selfNode].map(n => [n.id, n]));
const formatDate = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
let controller = null;
let currentRate = null;
let currentPhase = 'down';
let points = [];
let historyRows = [];
let storageAvailable = true;

function number(value) {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(value < 10 ? 2 : value < 1000 ? 1 : 0);
}
function mode() { return document.querySelector('input[name="mode"]:checked').value; }
function contextFor(canvas) {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return null;
  const scale = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) {
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function drawDial() {
  const frame = contextFor(dial);
  if (!frame) return;
  const { ctx, width, height } = frame;
  const x = width / 2, y = height * .58;
  const radius = Math.min(height * .435, width * .37);
  const start = Math.PI * .78, span = Math.PI * 1.44;
  const stops = [0, 1, 5, 10, 50, 100, 500, 1000, 2000];
  let position = 0;
  for (let i = 1; i < stops.length && currentRate > stops[i - 1]; i++) {
    position = (i - 1 + Math.min(1, (currentRate - stops[i - 1]) / (stops[i] - stops[i - 1]))) / (stops.length - 1);
  }
  const accent = colors[currentPhase] || colors.down;
  function arc(r, from, to, color, lineWidth) {
    ctx.beginPath(); ctx.arc(x, y, r, from, to);
    ctx.strokeStyle = color; ctx.lineWidth = lineWidth; ctx.stroke();
  }
  ctx.lineCap = 'butt';
  arc(radius - 14, start, start + span, '#33484b', 2);
  if (position > 0) arc(radius - 14, start, start + span * position, accent, 3);
  const divisions = 64;
  for (let i = 0; i <= divisions; i++) {
    const angle = start + span * i / divisions;
    const major = i % 8 === 0;
    const outer = radius + (major ? 2 : 0), inner = radius - (major ? 9 : 6);
    ctx.beginPath(); ctx.moveTo(x + Math.cos(angle) * outer, y + Math.sin(angle) * outer);
    ctx.lineTo(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner);
    ctx.strokeStyle = currentRate !== null && i / divisions <= position ? accent : (major ? '#a1bab5' : '#5c7674');
    ctx.lineWidth = major ? 2.5 : 1.6; ctx.stroke();
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '11px Consolas, monospace';
  ctx.fillStyle = '#a6b8b6';
  stops.forEach((stop, i) => {
    const a = start + span * i / (stops.length - 1), r = radius + 15;
    const label = stop < 1000 ? String(stop) : (stop === 1000 ? '1k' : '2k+');
    ctx.fillText(label, x + Math.cos(a) * r, y + Math.sin(a) * r);
  });
  if (currentRate !== null) {
    const a = start + span * position;
    ctx.beginPath(); ctx.arc(x + Math.cos(a) * (radius - 14), y + Math.sin(a) * (radius - 14), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = accent; ctx.fill();
  }
}

function niceMax(raw) {
  const unit = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
  return ([1, 2, 5, 10].find(n => n * unit >= raw) || 10) * unit;
}

function drawChart() {
  const frame = contextFor(chart);
  if (!frame) return;
  const { ctx, width, height } = frame;
  const left = 37, right = width - 10, top = 18, bottom = height - 21;
  const ymax = points.length ? niceMax(Math.max(...points.map(p => p.rate))) : 100;
  const xmax = points.length ? niceMax(Math.max(1, points.at(-1).seconds)) : 10;
  const px = val => left + val / xmax * (right - left);
  const py = val => bottom - val / ymax * (bottom - top);
  ctx.font = '10px Consolas, monospace'; ctx.fillStyle = '#91a4a7'; ctx.lineWidth = 1;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 2; i++) {
    const val = ymax * i / 2;
    const label = val >= 1000 ? String(Number((val / 1000).toFixed(1))) + 'k' : String(val);
    ctx.fillText(label, left - 7, py(val));
    ctx.beginPath(); ctx.setLineDash([3, 5]); ctx.strokeStyle = '#344549';
    ctx.moveTo(left, py(val) + .5); ctx.lineTo(right, py(val) + .5); ctx.stroke();
  }
  ctx.textAlign = 'left'; ctx.fillText('Mbps', 0, 5);
  for (let i = 0; i <= 4; i++) {
    const val = xmax * i / 4;
    ctx.beginPath(); ctx.setLineDash([2, 6]); ctx.strokeStyle = '#27393d';
    ctx.moveTo(px(val), top); ctx.lineTo(px(val), bottom); ctx.stroke();
    if (i % 2 === 0) {
      ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      ctx.fillText(Number(val.toFixed(1)) + ' s', px(val), bottom + 14);
    }
  }
  ctx.setLineDash([]);
  for (const phase of ['down', 'up']) {
    const series = points.filter(p => p.phase === phase);
    if (!series.length) continue;
    ctx.strokeStyle = colors[phase]; ctx.fillStyle = colors[phase]; ctx.lineWidth = 2;
    ctx.beginPath();
    series.forEach((p, i) => i ? ctx.lineTo(px(p.seconds), py(p.rate)) : ctx.moveTo(px(p.seconds), py(p.rate)));
    ctx.stroke();
    for (const p of series) {
      ctx.beginPath(); ctx.arc(px(p.seconds), py(p.rate), 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function readHistory() {
  const data = JSON.parse(localStorage.getItem(storeKey) || '[]');
  if (!Array.isArray(data)) return [];
  return data.filter(r => r && ['download','upload','latency','jitter'].every(k => Number.isFinite(r[k]) && r[k] >= 0)
    && Number.isFinite(r.at) && r.at > 0 && r.at <= 8.64e15 && Object.hasOwn(MODES, r.mode)
    && nodesById.has(r.node)).slice(0, 12);
}
function refreshHistory() {
  try { historyRows = readHistory(); }
  catch (error) {
    if (error instanceof SyntaxError) historyRows = [];
    else storageAvailable = false;
  }
}
function renderHistory() {
  const rows = el('history-rows');
  rows.replaceChildren();
  for (const h of historyRows) {
    const row = document.createElement('tr');
    const source = nodesById.get(h.node).label;
    for (const value of [formatDate.format(h.at), source + ' / ' + MODES[h.mode].label,
      number(h.download), number(h.upload), number(h.latency), number(h.jitter)]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    rows.append(row);
  }
  const empty = !historyRows.length;
  el('history-empty').hidden = !empty;
  el('history-table').hidden = empty;
  el('clear-history').hidden = empty;
  el('history-note').textContent = storageAvailable
    ? '最近 12 次完整测试，仅保存在此浏览器。' : '浏览器存储不可用，本页暂存最近 12 次完整测试。';
}
function saveHistory(result, modeName, nodeName) {
  if (storageAvailable) refreshHistory();
  historyRows = [{ at: Date.now(), mode: modeName, node: nodeName, ...result }, ...historyRows].slice(0, 12);
  try { localStorage.setItem(storeKey, JSON.stringify(historyRows)); }
  catch { storageAvailable = false; }
  renderHistory();
}
function setState(text, state) { status.textContent = text; status.dataset.state = state; }
function displayDial(value, label, phase) {
  currentRate = value; currentPhase = phase;
  el('gauge-value').textContent = number(value);
  el('gauge-label').textContent = label;
  document.querySelector('.gauge-unit').style.color = colors[phase] || colors.down;
  drawDial();
}
function resetMeter() {
  points = [];
  for (const id of Object.values(keys)) el(id).textContent = '—';
  el('chart-empty').hidden = false; el('test-error').hidden = true;
  nodeSelect.options[0].textContent = '自动选择';
  action.querySelector('span').textContent = '开始测速';
  displayDial(null, '连接速率', 'down'); drawChart(); setState('准备就绪', 'idle');
  const profile = MODES[mode()];
  note.textContent = '本次测试数据最多 ' + (profile.down + profile.up) / 1e6 + ' MB';
}
function handleEvent(e) {
  if (e.type === 'probeNode') {
    setState('连接节点', 'active'); note.textContent = '正在连接 ' + e.label + '…';
  } else if (e.type === 'node') {
    if (nodeSelect.value === 'auto') nodeSelect.options[0].textContent = '自动 · ' + e.label;
  } else if (e.type === 'phase') {
    setState(phaseNames[e.phase], 'active');
    note.textContent = e.phase === 'latency' ? '正在建立连接…' : '正在传输测试数据…';
    displayDial(null, e.phase === 'up' ? '实时上传' : e.phase === 'down' ? '实时下载' : '连接速率', e.phase);
  } else if (e.type === 'probe') {
    note.textContent = '延迟采样 ' + e.count + ' / ' + e.total;
  } else if (e.type === 'timing') {
    el(keys.latency).textContent = number(e.latency); el(keys.jitter).textContent = number(e.jitter);
  } else if (e.type === 'sample') {
    points.push({ phase: e.phase, rate: e.rate, seconds: e.seconds });
    el('chart-empty').hidden = true;
    el(keys[e.phase]).textContent = number(e.average);
    displayDial(e.rate, e.phase === 'down' ? '实时下载' : '实时上传', e.phase);
    note.textContent = '已完成 ' + (e.bytes / 1e6).toFixed(2) + ' MB · ' + e.seconds.toFixed(1) + ' 秒';
    drawChart();
  }
}
async function test() {
  if (controller) { controller.abort(); action.disabled = true; return; }
  const selectedMode = mode(), selectedNode = nodeSelect.value;
  const targets = selectedNode === 'auto' ? [...PUBLIC_NODES, staticNode] : [nodesById.get(selectedNode)];
  controller = new AbortController();
  resetMeter();
  el('modes').disabled = true; nodeSelect.disabled = true; action.dataset.running = 'true';
  action.querySelector('span').textContent = '停止测速';
  try {
    const result = await measureConnection({ nodes: targets,
      mode: selectedMode, signal: controller.signal, onEvent: handleEvent });
    const full = result.upload !== null;
    setState(full ? '测试完成' : '仅下载完成', 'done'); displayDial(result.download, '本次下载', 'down');
    note.textContent = '完成 ' + (result.bytes / 1e6).toFixed(2) + ' MB · 用时 ' + result.seconds.toFixed(1) + ' 秒';
    if (full) saveHistory(result, selectedMode, result.nodeId);
    else note.textContent += ' · 静态节点不支持上传，本次未计入历史。';
  } catch (error) {
    if (error.name === 'AbortError') setState('已停止', 'idle');
    else {
      el('test-error').textContent = error.message || '测速未完成，请重试。';
      el('test-error').hidden = false; setState('测试失败', 'error');
    }
    note.textContent = '本次测试未完成，未计入历史记录。';
  } finally {
    controller = null; action.dataset.running = 'false'; action.disabled = false;
    action.querySelector('span').textContent = '重新测速'; el('modes').disabled = false; nodeSelect.disabled = false;
  }
}

if (localNode) nodeSelect.add(new Option('本站节点 · 支持上传', 'self'));
action.addEventListener('click', test);
el('modes').addEventListener('change', resetMeter);
nodeSelect.addEventListener('change', resetMeter);
el('method-open').addEventListener('click', () => el('method-dialog').showModal());
el('clear-history').addEventListener('click', () => { el('clear-dialog').returnValue = ''; el('clear-dialog').showModal(); });
el('clear-dialog').addEventListener('close', () => {
  if (el('clear-dialog').returnValue !== 'clear') return;
  try { localStorage.removeItem(storeKey); } catch { storageAvailable = false; }
  historyRows = []; renderHistory();
});
window.addEventListener('storage', e => { if (!e.key || e.key === storeKey) { refreshHistory(); renderHistory(); } });
const resize = new ResizeObserver(() => { drawDial(); drawChart(); });
resize.observe(dial); resize.observe(chart);
refreshHistory(); renderHistory(); resetMeter();
