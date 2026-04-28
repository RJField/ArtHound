const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const { createRecords, selectAll, updateRecords } = require('../lib/airtable');
const config   = require('../config');

const router          = express.Router();
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'public', 'reviews');
const SERVER_URL      = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3000}`;

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// POST /api/reviews/submit  — called by the Maya script
router.post('/submit', async (req, res, next) => {
  try {
    const { assetName, sceneFile, artist, notes, screenshot } = req.body;

    // Resolve the asset name to a linked record ID
    let assetLink = [];
    if (assetName) {
      const escaped = assetName.replace(/"/g, '\\"');
      const matches = await selectAll(config.tables.assets, {
        filterByFormula: `{Name} = "${escaped}"`,
        maxRecords: 1,
        fields: ['Name'],
      });
      if (matches.length) assetLink = [matches[0].id];
    }

    let screenshotFile = null;
    if (screenshot) {
      const buf = Buffer.from(screenshot, 'base64');
      screenshotFile = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
      fs.writeFileSync(path.join(SCREENSHOTS_DIR, screenshotFile), buf);
    }

    const fields = {
      'Scene File':   sceneFile   || '',
      'Artist':       artist      || '',
      'Notes':        notes       || '',
      'Status':       'Pending',
      'Submitted At': new Date().toISOString(),
    };
    if (assetLink.length)  fields['Assets']      = assetLink;
    if (screenshotFile)    fields['Attachments'] = [{ url: `${SERVER_URL}/reviews/${screenshotFile}` }];

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

    // Resolve linked asset IDs → names in one batch request
    const assetIds = [...new Set(
      records.flatMap(r => r.fields['Assets'] || [])
    )];
    const assetNameMap = new Map();
    if (assetIds.length) {
      const formula = assetIds.map(id => `RECORD_ID()="${id}"`).join(',');
      const assetRecords = await selectAll(config.tables.assets, {
        filterByFormula: `OR(${formula})`,
        fields: ['Name'],
      });
      assetRecords.forEach(r => assetNameMap.set(r.id, r.fields['Name'] || ''));
    }

    res.json(records.map(r => {
      const linkedIds = r.fields['Assets'] || [];
      const assetName = linkedIds.map(id => assetNameMap.get(id) || id).join(', ');
      const attachment = (r.fields['Attachments'] || [])[0];
      return {
        id:          r.id,
        assetName,
        assetIds:    linkedIds,
        sceneFile:   r.fields['Scene File']   || '',
        artist:      r.fields['Artist']       || '',
        notes:       r.fields['Notes']        || '',
        status:      r.fields['Status']       || 'Pending',
        submittedAt: r.fields['Submitted At'] || '',
        screenshot:  attachment?.url ?? null,
      };
    }));
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
