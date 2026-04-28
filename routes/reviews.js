const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const { createRecords, selectAll, updateRecords } = require('../lib/airtable');
const config   = require('../config');

const router          = express.Router();
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'public', 'reviews');

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// POST /api/reviews/submit  — called by the Maya script
router.post('/submit', async (req, res, next) => {
  try {
    const { assetName, sceneFile, artist, notes, screenshot } = req.body;

    let screenshotFile = null;
    if (screenshot) {
      const buf = Buffer.from(screenshot, 'base64');
      screenshotFile = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
      fs.writeFileSync(path.join(SCREENSHOTS_DIR, screenshotFile), buf);
    }

    const fields = {
      'Asset Name':   assetName   || '',
      'Scene File':   sceneFile   || '',
      'Artist':       artist      || '',
      'Notes':        notes       || '',
      'Status':       'Pending',
      'Submitted At': new Date().toISOString(),
    };
    if (screenshotFile) fields['Screenshot'] = screenshotFile;

    const records = await createRecords(config.tables.reviews, [fields]);
    res.json({ ok: true, id: records[0].id });
  } catch (err) {
    next(err);
  }
});

// GET /api/reviews  — fetched by the web app
router.get('/', async (req, res, next) => {
  try {
    const records = await selectAll(config.tables.reviews, {
      sort: [{ field: 'Submitted At', direction: 'desc' }],
    });
    res.json(records.map(r => ({
      id:          r.id,
      assetName:   r.fields['Asset Name']   || '',
      sceneFile:   r.fields['Scene File']   || '',
      artist:      r.fields['Artist']       || '',
      notes:       r.fields['Notes']        || '',
      status:      r.fields['Status']       || 'Pending',
      submittedAt: r.fields['Submitted At'] || '',
      screenshot:  r.fields['Screenshot']  || null,
    })));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/reviews/:id/status
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });
    await updateRecords(config.tables.reviews, [{ id: req.params.id, fields: { Status: status } }]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
