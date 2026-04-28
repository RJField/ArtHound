const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { selectAll, updateRecords } = require('../lib/airtable');
const config = require('../config');

const router = express.Router();

const ESTIMATES_CONFIG_PATH = path.join(__dirname, '..', 'estimates.config.js');

async function fetchBaseSchema() {
  const { AIRTABLE_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const r = await fetch(
    `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error?.message || `Schema API returned ${r.status}`);
  }
  const { tables } = await r.json();
  return tables;
}

async function addFieldToTable(tableId, name, type = 'number', options = { precision: 1 }) {
  const { AIRTABLE_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const r = await fetch(
    `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables/${tableId}/fields`,
    {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, type, options }),
    }
  );
  const body = await r.json();
  if (!r.ok) throw new Error(body.error?.message || `Failed to add field "${name}": ${r.status}`);
  return body;
}

// Sanitise a value into a safe column name segment (no spaces/special chars)
function sanitize(str) {
  return String(str).replace(/[^a-zA-Z0-9]/g, '').slice(0, 25) || 'unknown';
}

function toColumnName(combo, variableFields) {
  return variableFields.map(f => sanitize(combo.values[f]?.name ?? 'unknown')).join('_');
}

function toConfigKey(combo, variableFields) {
  return variableFields.map(f => combo.values[f]?.name ?? '').join('|');
}

// Returns eligible variable fields from the assets table
router.get('/fields', async (req, res, next) => {
  try {
    const tables = await fetchBaseSchema();
    const assetsTable = tables.find(t => t.name === config.tables.assets);
    if (!assetsTable) throw new Error(`Assets table "${config.tables.assets}" not found`);

    const ELIGIBLE_TYPES = [
      'singleSelect', 'multipleSelects',
      'multipleRecordLinks',
      'number', 'rating',
      'lookup', 'multipleLookupValues', 'rollup',
    ];

    const fields = assetsTable.fields
      .filter(f => ELIGIBLE_TYPES.includes(f.type))
      .map(f => ({ id: f.id, name: f.name, type: f.type }));

    res.json({ fields });
  } catch (err) {
    next(err);
  }
});

// Returns distinct values for a given asset field
router.get('/field-values', async (req, res, next) => {
  try {
    const { field } = req.query;
    if (!field) return res.status(400).json({ error: 'field is required' });

    const tables = await fetchBaseSchema();
    const assetsTable = tables.find(t => t.name === config.tables.assets);
    if (!assetsTable) throw new Error(`Assets table "${config.tables.assets}" not found`);

    const fieldDef = assetsTable.fields.find(f => f.name === field);
    if (!fieldDef) throw new Error(`Field "${field}" not found`);

    let values = [];

    if (fieldDef.type === 'singleSelect' || fieldDef.type === 'multipleSelects') {
      values = (fieldDef.options?.choices ?? []).map(c => ({ id: c.name, name: c.name }));

    } else if (fieldDef.type === 'multipleRecordLinks') {
      const linkedTableId = fieldDef.options?.linkedTableId;
      const linkedTable   = tables.find(t => t.id === linkedTableId);
      if (!linkedTable) throw new Error(`Linked table not found for field "${field}"`);
      const primaryFieldName = linkedTable.fields[0]?.name ?? 'Name';
      const records = await selectAll(linkedTable.name, { fields: [primaryFieldName] });
      values = records.map(r => ({ id: r.id, name: r.fields[primaryFieldName] ?? r.id }));

    } else {
      // number, rating, lookup, multipleLookupValues — scan records for distinct values
      const records = await selectAll(config.tables.assets, { fields: [field] });
      const seen = new Map();
      records.forEach(r => {
        const raw = r.fields[field];
        const v   = Array.isArray(raw) ? raw[0] : raw;
        if (v != null) seen.set(String(v), v);
      });
      values = [...seen.entries()]
        .sort((a, b) => (a[1] > b[1] ? 1 : -1))
        .map(([k, v]) => ({ id: k, name: String(v) }));
    }

    res.json({ field, type: fieldDef.type, values });
  } catch (err) {
    next(err);
  }
});

// Adds one number column per combination to the Task Templates table,
// then writes estimates.config.js with the generated mappings.
router.post('/create-matrix', async (req, res, next) => {
  try {
    const { variables, combinations } = req.body;
    // variables:    [{field, type}]
    // combinations: [{label, values: {fieldName: {id, name}}}]

    const variableFields = variables.map(v => v.field);

    const tables = await fetchBaseSchema();
    const templatesTable = tables.find(t => t.name === config.tables.templates);
    if (!templatesTable) throw new Error(`Templates table "${config.tables.templates}" not found`);

    const existingFieldNames = new Set(templatesTable.fields.map(f => f.name));

    const created  = [];
    const skipped  = [];
    const configMap = {};

    for (const combo of combinations) {
      const colName  = toColumnName(combo, variableFields);
      const configKey = toConfigKey(combo, variableFields);

      if (existingFieldNames.has(colName)) {
        skipped.push(colName);
      } else {
        await addFieldToTable(templatesTable.id, colName, 'number', { precision: 1 });
        created.push(colName);
        existingFieldNames.add(colName);
      }

      configMap[configKey] = colName;
    }

    // Write estimates.config.js
    const lines = [
      '// Auto-generated by ArtHound estimation engine setup wizard.',
      '// Key format: "VAR1|VAR2|VAR3" where values match field values in the Assets table.',
      `// Variable order: ${variableFields.join(' | ')}`,
      '//',
      '// To regenerate, re-run the ⚙ setup wizard in the app.',
      '',
      'module.exports = {',
      `  _variableFields: ${JSON.stringify(variableFields)},`,
      '',
      ...Object.entries(configMap).map(([k, v]) => `  '${k}': '${v}',`),
      '};',
    ];
    fs.writeFileSync(ESTIMATES_CONFIG_PATH, lines.join('\n'), 'utf8');

    res.json({
      templatesTable: templatesTable.name,
      created:  created.length,
      skipped:  skipped.length,
      columns:  created,
    });
  } catch (err) {
    next(err);
  }
});

// Receives parsed CSV rows and writes non-empty numeric values back to Task Templates.
// Request: { headers: string[], rows: string[][] }
// Response: { updated, cellsWritten, notFound: string[] }
router.post('/import-csv', async (req, res, next) => {
  try {
    const { headers, rows } = req.body;
    if (!Array.isArray(headers) || !Array.isArray(rows)) {
      return res.status(400).json({ error: 'headers and rows are required' });
    }

    const taskColIdx = headers.indexOf('Task');
    if (taskColIdx === -1) return res.status(400).json({ error: 'CSV must have a "Task" column' });

    // Load valid estimate column names from config (bust cache for freshness)
    const configPath = require.resolve('../estimates.config');
    delete require.cache[configPath];
    const estimatesConfig = require(configPath);
    const validCols = new Set(
      Object.entries(estimatesConfig)
        .filter(([k]) => k !== '_variableFields')
        .map(([, v]) => v)
    );

    // Map header index → column name for valid estimate columns only
    const colMap = []; // [{idx, colName}]
    headers.forEach((h, i) => { if (i !== taskColIdx && validCols.has(h)) colMap.push({ idx: i, colName: h }); });

    // Fetch Task Templates, build name → record ID map
    const templates = await selectAll(config.tables.templates);
    const nameToId = new Map(
      templates.filter(t => t.fields['Task']).map(t => [t.fields['Task'], t.id])
    );

    const updates  = [];
    const notFound = [];
    let cellsWritten = 0;

    for (const row of rows) {
      const taskName = (row[taskColIdx] ?? '').trim();
      if (!taskName) continue;

      const recordId = nameToId.get(taskName);
      if (!recordId) { notFound.push(taskName); continue; }

      const fields = {};
      for (const { idx, colName } of colMap) {
        const raw = (row[idx] ?? '').trim();
        if (raw === '') continue;
        const num = parseFloat(raw);
        if (!isNaN(num)) { fields[colName] = num; cellsWritten++; }
      }
      if (Object.keys(fields).length) updates.push({ id: recordId, fields });
    }

    if (updates.length) await updateRecords(config.tables.templates, updates);

    res.json({ updated: updates.length, cellsWritten, notFound });
  } catch (err) {
    next(err);
  }
});

// Downloads a CSV of Task Templates with one column per estimate combination.
// The user fills in day values and can use it as an offline reference.
router.get('/export-csv', async (req, res, next) => {
  try {
    // Bust require cache so we always read the latest written config
    const configPath = require.resolve('../estimates.config');
    delete require.cache[configPath];
    const estimatesConfig = require(configPath);

    const colEntries = Object.entries(estimatesConfig).filter(([k]) => k !== '_variableFields');
    if (!colEntries.length) {
      return res.status(400).json({ error: 'No estimate columns configured — run the setup wizard first.' });
    }
    const colNames = colEntries.map(([, v]) => v); // Airtable column names, e.g. 'Mace_Maps_1'

    const templates = await selectAll(config.tables.templates);

    function cell(val) {
      if (val == null) return '';
      const s = String(val);
      return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? `"${s.replace(/"/g, '""')}"` : s;
    }

    const headers = ['Task', ...colNames];
    const rows = templates
      .filter(t => t.fields['Task'])
      .map(t => [t.fields['Task'], ...colNames.map(col => t.fields[col] ?? '')]);

    const csv = [headers, ...rows].map(r => r.map(cell).join(',')).join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="estimate-matrix.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
