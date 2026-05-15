// Custom CORS proxy that spoofs Referer + User-Agent per request.
// Bypasses hotlink protection on CDNs like cdn.oceanographicmagazine.com.
// No npm install required — uses only Node built-in modules.
//
// Usage:  node proxy.js
// Stop:   Ctrl+C  (or close the CMD window)
// Listens: http://127.0.0.1:8081

const http  = require('http');
const https = require('https');

const PORT = 8081;

// Extract the apex domain to use as Referer.
//   cdn.oceanographicmagazine.com  → oceanographicmagazine.com
//   www.example.co.uk              → example.co.uk
//   121clicks.com                  → 121clicks.com
function apexDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  // .co.uk / .com.au / .co.jp style multi-part TLDs
  if (last.length === 2 && secondLast.length <= 3) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'content-length, content-type'
};

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(200, CORS); res.end(); return; }

  const target = req.url.slice(1); // strip leading '/'
  if (!/^https?:\/\//i.test(target)) {
    res.writeHead(400, CORS);
    res.end('Bad request — URL must start with http:// or https://');
    return;
  }

  let parsed;
  try { parsed = new URL(target); }
  catch (e) { res.writeHead(400, CORS); res.end('Bad URL: ' + e.message); return; }

  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;
  const referer = `https://${apexDomain(parsed.hostname)}/`;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': referer,
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    const headers = Object.assign({}, proxyRes.headers, CORS);
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    console.error('[proxy error]', target, '→', err.message);
    res.writeHead(502, CORS);
    res.end('Proxy error: ' + err.message);
  });

  req.pipe(proxyReq);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Custom proxy on http://127.0.0.1:${PORT} — Ctrl+C to stop`);
  console.log('Spoofs Referer (target apex domain) + Chrome User-Agent');
});
