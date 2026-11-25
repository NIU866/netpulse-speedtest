import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { measureConnection, MODES } from '../measure.js';

let child, origin;
before(async () => {
  child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
    cwd: new URL('../', import.meta.url), env: { ...process.env, HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const output = createInterface({ input: child.stdout });
  try {
    for await (const line of output) {
      if (line.startsWith('NetPulse listening at ')) { origin = line.slice('NetPulse listening at '.length); break; }
    }
  } finally { output.close(); }
  assert.ok(origin, '测速节点启动成功');
});
after(async () => {
  if (child && child.exitCode === null && !child.killed) {
    const stopped = once(child, 'exit'); child.kill(); await stopped;
  }
});

test('local node advertises itself and verifies the POST payload size', async () => {
  const index = await (await fetch(origin)).text();
  assert.match(index, /name="netpulse-local-node" content="on"/);
  const down = await fetch(origin + '/__down?bytes=325');
  assert.equal((await down.arrayBuffer()).byteLength, 325);
  const up = await fetch(origin + '/__up', { method: 'POST', body: new Uint8Array(917) });
  assert.equal(up.headers.get('x-netpulse-bytes'), '917');
  assert.equal(await up.text(), '917');
  for (const input of ['-1', '8000001', 'x']) {
    assert.equal((await fetch(origin + '/__down?bytes=' + input)).status, 400);
  }
});

for (const mode of Object.keys(MODES)) {
  test(mode + ' measures real payloads and respects each direction’s budget', async () => {
    const events = [];
    const result = await measureConnection({ origin, mode, signal: new AbortController().signal, onEvent: e => events.push(e) });
    assert.deepEqual(events.filter(e => e.type === 'phase').map(e => e.phase), ['latency', 'down', 'up']);
    assert.equal(events.filter(e => e.type === 'probe').length, MODES[mode].probes);
    const downEnd = events.filter(e => e.type === 'sample' && e.phase === 'down').at(-1);
    assert.ok(downEnd.bytes > 0 && downEnd.bytes <= MODES[mode].down);
    assert.ok(result.bytes > downEnd.bytes && result.bytes - downEnd.bytes <= MODES[mode].up);
    for (const key of ['download', 'upload', 'seconds']) assert.ok(Number.isFinite(result[key]) && result[key] > 0);
    assert.ok(result.latency >= 0 && result.jitter >= 0);
  });
}

test('cancel stops subsequent probes and a pre-cancelled run rejects', async () => {
  const abort = new AbortController();
  const events = [];
  await assert.rejects(measureConnection({
    origin, signal: abort.signal, onEvent: e => { events.push(e); if (e.type === 'probe') abort.abort(); },
  }), { name: 'AbortError' });
  assert.equal(events.filter(e => e.type === 'probe').length, 1);
  const again = new AbortController(); again.abort();
  await assert.rejects(measureConnection({ origin, signal: again.signal }), { name: 'AbortError' });
});

test('a short download or an upload landing page cannot produce a completed result', async () => {
  let fault = 'short';
  const mock = createServer((req, res) => {
    if (req.method === 'POST') { req.resume(); req.on('end', () => res.end('<!doctype html><title>Sign in</title>')); return; }
    const size = Number(new URL(req.url, origin).searchParams.get('bytes'));
    res.end(Buffer.alloc(fault === 'short' && size ? size - 1 : size));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const target = 'http://127.0.0.1:' + mock.address().port;
  try {
    await assert.rejects(measureConnection({ origin: target, signal: new AbortController().signal }), /长度/);
    fault = 'portal';
    await assert.rejects(measureConnection({ origin: target, signal: new AbortController().signal }), /确认/);
  } finally { const closed = once(mock, 'close'); mock.close(); await closed; }
});
