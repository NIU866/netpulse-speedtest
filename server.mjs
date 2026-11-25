import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/netpulse.css', ['netpulse.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
  ['/measure.js', ['measure.js', 'text/javascript; charset=utf-8']],
]);
const maximum = 8_000_000;
const downloadData = randomBytes(maximum);
const hostname = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 应为 0 至 65535 的整数');

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (['/__down', '/__up'].includes(url.pathname) && req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403).end();
      return;
    }
    if (url.pathname === '/__down' && req.method === 'GET') {
      const query = url.searchParams.get('bytes');
      const bytes = Number(query);
      if (!/^\d+$/.test(query || '') || !Number.isSafeInteger(bytes) || bytes > maximum) {
        res.writeHead(400).end('Invalid size');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes });
      res.end(downloadData.subarray(0, bytes));
      return;
    }
    if (url.pathname === '/__up' && req.method === 'POST') {
      let count = 0;
      for await (const chunk of req) {
        count += chunk.length;
        if (count > maximum) {
          res.writeHead(413, { Connection: 'close' }).end();
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-NetPulse-Bytes': String(count) });
      res.end(String(count));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/sample.bin') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 524288 });
      res.end(downloadData.subarray(0, 524288));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/ping.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('netpulse\n');
      return;
    }
    const asset = assets.get(url.pathname);
    if (!asset || req.method !== 'GET') {
      res.writeHead(404).end('Not found');
      return;
    }
    let contents = await readFile(new URL(asset[0], import.meta.url), 'utf8');
    if (asset[0] === 'index.html') {
      contents = contents.replace('name="netpulse-local-node" content="off"', 'name="netpulse-local-node" content="on"');
    }
    res.writeHead(200, { 'Content-Type': asset[1] }).end(contents);
  } catch {
    if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
    else res.destroy();
  }
});
server.requestTimeout = 30_000;
server.listen(port, hostname, () => {
  const address = server.address();
  const host = hostname.includes(':') ? '[' + hostname + ']' : hostname;
  console.log('NetPulse listening at http://' + host + ':' + address.port);
});
