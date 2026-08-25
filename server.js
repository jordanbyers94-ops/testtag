require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// --- Auth gate: same pattern as TouchTrace / Job Capture ---
// APP_ACCESS_TOKEN is shared with the team; browser sends it as
// header "x-app-token". Public static files and health check are exempt.
function requireAccessToken(req, res, next) {
  const openPaths = ['/health', '/'];
  if (openPaths.includes(req.path) || req.path.startsWith('/index.html') || req.path.startsWith('/app.js') || req.path.startsWith('/style.css')) {
    return next();
  }
  const token = req.header('x-app-token');
  if (!process.env.APP_ACCESS_TOKEN) {
    console.warn('APP_ACCESS_TOKEN not set - refusing all API requests.');
    return res.status(500).json({ error: 'Server not configured (APP_ACCESS_TOKEN missing).' });
  }
  if (token !== process.env.APP_ACCESS_TOKEN) {
    return res.status(401).json({ error: 'Invalid or missing access token.' });
  }
  next();
}

app.use('/api', requireAccessToken);

app.use('/api/extract', require('./routes/extract'));
app.use('/api/assets', require('./routes/assets'));
app.use('/api/register', require('./routes/register'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Test & Tag app listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
