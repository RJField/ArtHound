const express = require('express');
const { buildSchedule } = require('../lib/scheduler');
const { createRecords } = require('../lib/airtable');
const config = require('../config');

const router = express.Router();

router.post('/preview', async (req, res, next) => {
  try {
    const { assetId } = req.body;
    if (!assetId) return res.status(400).json({ error: 'assetId is required' });
    const result = await buildSchedule(assetId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/generate', async (req, res, next) => {
  try {
    const { assetId } = req.body;
    if (!assetId) return res.status(400).json({ error: 'assetId is required' });

    const result = await buildSchedule(assetId);

    const records = result.tasks.map(task => ({
      'Asset':  [assetId],
      'Task':      task.taskName,
      'Estimate':  task.estimate,
      'Craft': task.capCraftIds,
      'Start Date': task.startDate,
      'End Date':   task.endDate,
    }));

    const created = await createRecords(config.tables.tasks, records);
    res.json({ ...result, created: created.length });
  } catch (err) {
    next(err);
  }
});

router.post('/generate-bulk', async (req, res, next) => {
  try {
    const { assetIds } = req.body;
    if (!Array.isArray(assetIds) || !assetIds.length) {
      return res.status(400).json({ error: 'assetIds array is required' });
    }

    const results = await Promise.allSettled(assetIds.map(id => buildSchedule(id)));

    const allRecords = [];
    const failed = [];

    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        result.value.tasks.forEach(task => {
          allRecords.push({
            'Asset':      [assetIds[i]],
            'Task':       task.taskName,
            'Estimate':   task.estimate,
            'Craft':      task.capCraftIds,
            'Start Date': task.startDate,
            'End Date':   task.endDate,
          });
        });
      } else {
        failed.push({ id: assetIds[i], error: result.reason?.message ?? 'Unknown error' });
      }
    });

    const created = allRecords.length ? await createRecords(config.tables.tasks, allRecords) : [];
    res.json({ created: created.length, failed });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
