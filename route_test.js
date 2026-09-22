const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/assets', require('./routes/assets'));
const server = app.listen(4321, () => console.log('listening'));

const http = require('http');
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: 4321, path, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const cases = [
    ['GET', '/api/assets/sites'],
    ['GET', '/api/assets/due-summary'],
    ['GET', '/api/assets/by-tag/ABC123'],
    ['GET', '/api/assets/match?site=x&plant_no=1'],
    ['GET', '/api/assets/42'],
    ['GET', '/api/assets/42/history'],
    ['PATCH', '/api/assets/42', { site: 'Test Site' }],
    ['DELETE', '/api/assets/42'],
    ['GET', '/api/assets/tests/9/photo'],
    ['GET', '/api/assets'],
  ];
  for (const [method, path, body] of cases) {
    const r = await req(method, path, body);
    console.log(method.padEnd(6), path.padEnd(35), '->', r.status, (r.body||'').slice(0,80));
  }
  server.close();
})();
