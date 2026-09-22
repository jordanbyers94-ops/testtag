const { JSDOM } = require('jsdom');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  const map = {
    '/testtag/': 'public/index.html',
    '/testtag/index.html': 'public/index.html',
    '/testtag/app.js': 'public/app.js',
    '/testtag/technician-profile.js': 'public/technician-profile.js',
    '/testtag/style.css': 'public/style.css',
    '/': 'public/index.html',       // simulate standalone hosting at domain root too
    '/index.html': 'public/index.html',
    '/app.js': 'public/app.js',
    '/technician-profile.js': 'public/technician-profile.js',
    '/style.css': 'public/style.css',
  };
  const file = map[req.url];
  if (!file) { res.statusCode = 404; return res.end('not found: ' + req.url); }
  res.setHeader('content-type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(path.join(__dirname, file), 'utf8'));
});

server.listen(4502, async () => {
  try {
    // Scenario 1: proxied under /testtag/
    const dom1 = await JSDOM.fromURL('http://localhost:4502/testtag/', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
    dom1.window.fetch = async () => ({ ok: true, status: 200, json: async () => ([]), blob: async () => ({}) });
    dom1.window.localStorage.setItem('testTagAccessToken', 'x');
    await new Promise((r) => setTimeout(r, 500));
    const btn1 = dom1.window.document.getElementById('btnHomeTestTag');
    console.log('[proxied] home button visible:', btn1.style.display === 'inline-block');
    // Compute what the click handler would navigate to, same formula as app.js
    const expectedHome = new dom1.window.URL('../', dom1.window.location.href).pathname;
    console.log('[proxied] computed home URL:', expectedHome, '(expect "/")');

    // Scenario 2: standalone at domain root
    const dom2 = await JSDOM.fromURL('http://localhost:4502/', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
    dom2.window.fetch = async () => ({ ok: true, status: 200, json: async () => ([]), blob: async () => ({}) });
    await new Promise((r) => setTimeout(r, 500));
    const btn2 = dom2.window.document.getElementById('btnHomeTestTag');
    console.log('[standalone] home button visible:', btn2.style.display === 'inline-block', '(expect false)');
    console.log('[standalone] home button display value:', JSON.stringify(btn2.style.display));
  } catch (e) {
    console.log('ERROR', e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
