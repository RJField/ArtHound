const express = require('express');
const { selectAll, findRecord, updateRecords } = require('../lib/airtable');
const config = require('../config');

const router = express.Router();

function resolveName(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value[0];
    if (!first) return null;
    if (typeof first === 'string') return first;
    return first.name ?? first.id ?? null;
  }
  return value.name ?? null;
}

function linkId(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.id ?? null;
}

async function fetchProductNames() {
  const records = await selectAll(config.tables.products, { fields: ['Product'] });
  return new Map(records.map(r => [r.id, r.fields['Product'] ?? r.id]));
}

async function fetchItemTypeNames() {
  const records = await selectAll(config.tables.itemTypes, { fields: ['Item'] });
  return new Map(records.map(r => [r.id, r.fields['Item'] ?? r.id]));
}

function normalizeAsset(r, productNames = new Map(), itemTypeNames = new Map()) {
  const milestone4   = r.fields['Milestone 4 [Dates]'];
  const productLinks = r.fields['Product']   || [];
  const itemLinks    = r.fields['Item Type'] || [];
  const productId    = linkId(productLinks[0]);
  const itemTypeId   = linkId(itemLinks[0]);

  return {
    id:          r.id,
    assetNumber: r.fields['ID'] ?? null,
    name:        resolveName(r.fields['Name']) ?? null,
    devName:     resolveName(r.fields['Dev Name']) ?? null,
    product:     productId   ? (productNames.get(productId)   ?? productId)   : null,
    itemType:    itemTypeId  ? (itemTypeNames.get(itemTypeId) ?? itemTypeId)  : null,
    team:        resolveName(r.fields['Team (from Product)']) ?? null,
    priority:    r.fields['Priority'] ?? null,
    projectDate: Array.isArray(milestone4) ? (milestone4[0] ?? null) : (milestone4 ?? null),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const options = {
      fields: ['Name', 'ID', 'Dev Name', 'Product', 'Item Type', 'Team (from Product)', 'Priority', 'Milestone 4 [Dates]'],
      sort: [{ field: 'Name', direction: 'asc' }],
    };
    if (req.query.search) {
      const q = req.query.search.replace(/["'\\]/g, '');
      options.filterByFormula = `SEARCH("${q}", {Name})`;
    }

    const [records, productNames, itemTypeNames] = await Promise.all([
      selectAll(config.tables.assets, options),
      fetchProductNames(),
      fetchItemTypeNames(),
    ]);

    res.json(records.map(r => normalizeAsset(r, productNames, itemTypeNames)));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [record, productNames, itemTypeNames] = await Promise.all([
      findRecord(config.tables.assets, req.params.id),
      fetchProductNames(),
      fetchItemTypeNames(),
    ]);
    res.json(normalizeAsset(record, productNames, itemTypeNames));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/name', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    await updateRecords(config.tables.assets, [{ id: req.params.id, fields: { Name: name } }]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
