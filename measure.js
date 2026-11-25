export const CLOUDFLARE = 'https://speed.cloudflare.com';
export const PUBLIC_NODES = [
  { id: 'cloudflare', label: 'Cloudflare', type: 'bytes', base: CLOUDFLARE },
  { id: 'tokyo', label: '东京 · A573', type: 'librespeed', base: 'https://librespeed.a573.net/backend/' },
  { id: 'losangeles', label: '洛杉矶 · Clouvider', type: 'librespeed', base: 'https://la.speedtest.clouvider.net/backend/' },
];
export const STATIC_CHUNK = 524_288;

export const MODES = Object.freeze({
  light: { label: '轻量', down: 8_000_000, up: 2_000_000, probes: 6, windowMs: 3500 },
  standard: { label: '标准', down: 32_000_000, up: 8_000_000, probes: 8, windowMs: 6500 },
});

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function makePayload(bytes) {
  const data = new Uint8Array(bytes);
  // Web Crypto accepts at most 65,536 bytes per call.
  for (let offset = 0; offset < bytes; offset += 65_536) {
    crypto.getRandomValues(data.subarray(offset, Math.min(offset + 65_536, bytes)));
  }
  return data;
}

export async function measureConnection({
  origin = CLOUDFLARE, nodes = [{ id: 'custom', label: '测速节点', type: 'bytes', base: origin }],
  mode = 'light', signal, onEvent = () => {},
}) {
  const profile = MODES[mode];
  if (!profile) throw new Error('未知的测速模式。');
  const start = performance.now();
  const runId = Array.from(crypto.getRandomValues(new Uint32Array(2))).join('-');
  let sequence = 0;
  let completedBytes = 0;
  let node = nodes[0];
  if (!node) throw new Error('请选择测速节点。');

  function report(event) {
    onEvent({ ...event, seconds: (performance.now() - start) / 1000, bytes: completedBytes });
  }

  async function transfer(direction, size, timeout = 15_000) {
    if (signal.aborted) throw new DOMException('测试已停止', 'AbortError');
    const upload = direction === 'up';
    const ping = !upload && size === 0;
    let path = upload ? '/__up' : '/__down';
    if (node.type === 'librespeed') path = upload || ping ? 'empty.php' : 'garbage.php';
    if (node.type === 'static') path = ping ? 'ping.txt' : 'sample.bin';
    const url = new URL(path, node.base);
    url.searchParams.set('r', runId + '-' + (++sequence));
    if (node.type === 'bytes' && !upload) url.searchParams.set('bytes', String(size));
    if (node.type === 'librespeed') {
      url.searchParams.set('cors', 'true');
      if (!upload && !ping) url.searchParams.set('ckSize', String(size / 1_048_576));
    }
    const body = upload ? makePayload(size) : undefined;
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener('abort', stop, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const before = performance.now();
    try {
      const response = await fetch(url, {
        method: upload ? 'POST' : 'GET', body, signal: controller.signal,
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error('测速节点返回 HTTP ' + response.status + '。');
      const data = await response.arrayBuffer();
      const elapsed = performance.now() - before;
      if (ping && node.type !== 'bytes') {
        const marker = data.byteLength < 128 ? new TextDecoder().decode(data).trim() : null;
        if (marker !== (node.type === 'static' ? 'netpulse' : '')) throw new Error('节点探测响应无效。');
      } else if (!upload && data.byteLength !== size) {
        throw new Error('下载数据长度与请求不符。');
      }
      if (upload) {
        const ack = response.headers.get('X-NetPulse-Bytes');
        const prefix = new TextDecoder().decode(data.slice(0, 128)).trimStart();
        if ((ack !== null && Number(ack) !== size) || /^(?:<!doctype\s+html|<html\b)/i.test(prefix)) {
          throw new Error('测速节点没有确认这次上传。');
        }
      }
      return elapsed;
    } catch (error) {
      if (signal.aborted) throw new DOMException('测试已停止', 'AbortError');
      if (timedOut) throw new Error('测速请求超时。请检查网络或稍后重试。');
      if (error instanceof TypeError) throw new Error('无法连接测速节点。请检查网络、代理或浏览器拦截设置。');
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    }
  }

  async function measureRate(direction) {
    report({ type: 'phase', phase: direction });
    const limit = profile[direction];
    const maximumChunk = direction === 'down' ? 8_000_000 : 2_000_000;
    let chunk = direction === 'down' ? 96_000 : 48_000;
    let bytes = 0;
    let milliseconds = 0;
    let samples = 0;
    const quantum = direction !== 'down' ? 1 : node.type === 'librespeed' ? 1_048_576 : node.type === 'static' ? STATIC_CHUNK : 1;
    while (limit - bytes >= quantum && samples < 24 && (samples < 2 || milliseconds < profile.windowMs)) {
      const available = Math.min(Math.max(quantum, chunk), limit - bytes);
      const size = node.type === 'static' ? STATIC_CHUNK : Math.floor(available / quantum) * quantum;
      const elapsed = await transfer(direction, size);
      if (elapsed <= 0) throw new Error('浏览器计时精度不足，请在浏览器前台重试。');
      bytes += size;
      completedBytes += size;
      milliseconds += elapsed;
      samples++;
      report({ type: 'sample', phase: direction, rate: size * 8 / (elapsed * 1000),
        average: bytes * 8 / (milliseconds * 1000), count: samples });
      // Aim for roughly one second per request, without spending the entire budget on a single probe.
      chunk = Math.max(16_000, Math.min(maximumChunk, size * 8, Math.round(size * 900 / elapsed)));
    }
    return bytes * 8 / (milliseconds * 1000);
  }

  // Only empty probes may fail over. Once bandwidth measurement starts, samples all refer to one node.
  for (let index = 0; index < nodes.length; index++) {
    node = nodes[index];
    report({ type: 'probeNode', label: node.label });
    try {
      const timeout = nodes.length > 1 ? 4000 : 15_000;
      await transfer('down', 0, timeout);
      if (nodes.length > 1 && node.type !== 'static') await transfer('up', 0, timeout);
      break;
    } catch (error) {
      if (signal.aborted || index === nodes.length - 1) throw error;
    }
  }
  report({ type: 'node', nodeId: node.id, label: node.label });
  report({ type: 'phase', phase: 'latency' });
  const times = [];
  for (let index = 0; index < profile.probes; index++) {
    times.push(await transfer('down', 0));
    report({ type: 'probe', phase: 'latency', count: times.length, total: profile.probes });
  }
  const latency = median(times);
  const differences = times.slice(1).map((value, index) => Math.abs(value - times[index]));
  const jitter = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  report({ type: 'timing', phase: 'latency', latency, jitter });
  const download = await measureRate('down');
  const upload = node.type === 'static' ? null : await measureRate('up');
  return { latency, jitter, download, upload, nodeId: node.id, bytes: completedBytes,
    seconds: (performance.now() - start) / 1000 };
}
