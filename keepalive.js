const http = require('http');
const https = require('https');
const { URL } = require('url');

const TARGET = process.env.KEEPALIVE_TARGET || `http://localhost:${process.env.PORT || 3000}/health`;
const INTERVAL_MS = parseInt(process.env.KEEPALIVE_INTERVAL_MS || String(5 * 60 * 1000), 10); // default 5 minutes
const TIMEOUT_MS = parseInt(process.env.KEEPALIVE_TIMEOUT_MS || '10000', 10); // 10s

function ping() {
  try {
    const u = new URL(TARGET);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: TIMEOUT_MS }, (res) => {
      console.log(new Date().toISOString(), 'keepalive ping', TARGET, 'status', res.statusCode);
      // drain
      res.on('data', () => {});
      res.on('end', () => {});
    });
    req.on('error', (err) => {
      console.error(new Date().toISOString(), 'keepalive error', err && err.message);
    });
    req.on('timeout', () => {
      console.error(new Date().toISOString(), 'keepalive timeout');
      req.abort();
    });
  } catch (err) {
    console.error(new Date().toISOString(), 'keepalive fatal', err && err.message);
  }
}

console.log('Keepalive starting. Target:', TARGET, 'Interval(ms):', INTERVAL_MS);
// initial ping immediately
ping();
// schedule
setInterval(ping, INTERVAL_MS);

process.on('unhandledRejection', (r) => { console.error('keepalive unhandledRejection', r); });
process.on('uncaughtException', (e) => { console.error('keepalive uncaughtException', e); process.exit(1); });
