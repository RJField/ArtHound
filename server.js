require('dotenv').config();
const express = require('express');
const path = require('path');

const assetsRouter   = require('./routes/assets');
const scheduleRouter = require('./routes/schedule');
const schemaRouter   = require('./routes/schema');
const setupRouter    = require('./routes/setup');
const reviewsRouter  = require('./routes/reviews');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/assets',   assetsRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api/schema',   schemaRouter);
app.use('/api/setup',    setupRouter);
app.use('/api/reviews',  reviewsRouter);

app.get('/api/config', (req, res) => {
  const baseId = process.env.AIRTABLE_BASE_ID || '';
  res.json({ airtableUrl: baseId ? `https://airtable.com/${baseId}` : null });
});

// Temporary debug route — remove once auth is confirmed working
app.get('/api/debug', async (req, res) => {
  const { AIRTABLE_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const results = {};

  // Test 1: whoami (confirms token is valid)
  try {
    const r = await fetch('https://api.airtable.com/v0/meta/whoami', {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });
    results.whoami = { status: r.status, body: await r.json() };
  } catch (e) {
    results.whoami = { error: e.message };
  }

  // Test 2: list bases (confirms workspace access)
  try {
    const r = await fetch('https://api.airtable.com/v0/meta/bases', {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });
    results.bases = { status: r.status, body: await r.json() };
  } catch (e) {
    results.bases = { error: e.message };
  }

  // Test 3: list tables in the base (confirms schema access + shows actual table names)
  try {
    const r = await fetch(`https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });
    const body = await r.json();
    results.tables = {
      status: r.status,
      names: body.tables?.map(t => t.name) ?? body,
    };
  } catch (e) {
    results.tables = { error: e.message };
  }

  // Test 4: read one record from the Assets table (confirms data.records:read scope)
  try {
    const table = encodeURIComponent(process.env.TABLE_ASSETS || '[Robin] Assets');
    const r = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${table}?maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    results.records = { status: r.status, body: await r.json() };
  } catch (e) {
    results.records = { error: e.message };
  }

  res.json({ token_prefix: AIRTABLE_TOKEN?.slice(0, 20) + '…', base_id: AIRTABLE_BASE_ID, results });
});

// Central error handler
app.use((err, req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ error: err.message });
});

process.on('uncaughtException',  err => console.error('[uncaughtException]',  err.stack || err.message));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err?.stack || err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ArtHound running at http://localhost:${PORT}`));
