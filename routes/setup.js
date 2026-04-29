const express = require('express');
const fs      = require('fs');
const https   = require('https');
const path    = require('path');
const { selectAll, updateRecords } = require('../lib/airtable');
const config = require('../config');

const router = express.Router();

const ESTIMATES_CONFIG_PATH = path.join(__dirname, '..', 'estimates.config.json');

function readEstimatesConfig() {
  try {
    return JSON.parse(fs.readFileSync(ESTIMATES_CONFIG_PATH, 'utf8'));
  } catch (_) {
    return { _variableFields: [] };
  }
}

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

// Low-level HTTPS request using Node's built-in https module.
// Native fetch (undici) can emit ECONNRESET as an uncaught exception in some Node 18.x builds;
// https.request always routes errors through the 'error' event → Promise rejection → catchable.
function httpsRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const req = https.request(
      {
        hostname: 'api.airtable.com',
        path,
        method,
        agent: false, // fresh connection per request — avoids keep-alive socket reuse crashes
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(raw); } catch (_) {}
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}: ${raw.slice(0, 120)}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function fetchRecordsDirect(tableId, fields = []) {
  const { AIRTABLE_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const records = [];
  let offset;
  do {
    const params = new URLSearchParams();
    fields.forEach(f => params.append('fields[]', f));
    if (offset) params.set('offset', offset);
    const data = await httpsRequest(
      'GET',
      `/v0/${AIRTABLE_BASE_ID}/${tableId}?${params}`,
      AIRTABLE_TOKEN
    );
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records;
}

async function patchRecords(tableId, updates) {
  const { AIRTABLE_TOKEN, AIRTABLE_BASE_ID } = process.env;
  for (let i = 0; i < updates.length; i += 10) {
    if (i > 0) await new Promise(r => setTimeout(r, 300));
    const batch = updates.slice(i, i + 10);
    console.log(`[patchRecords] batch ${i}–${i + batch.length - 1} of ${updates.length}`);
    await httpsRequest(
      'PATCH',
      `/v0/${AIRTABLE_BASE_ID}/${tableId}`,
      AIRTABLE_TOKEN,
      { records: batch }
    );
  }
}

async function deleteField(tableId, fieldId) {
  const { AIRTABLE_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const r = await fetch(
    `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables/${tableId}/fields/${fieldId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error?.message || `Failed to delete field ${fieldId}: ${r.status}`);
  }
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

// TODO: column name segment order is determined by wizard selection order (Set insertion order),
// which means clicking "Item Type" before "Team" produces "Axe_Characters" not "Characters_Axe".
// Revisit: enforce a canonical field order (e.g. alphabetical or schema order) so names are stable.
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

// Returns unique variable-field combinations that exist in the Assets table,
// with a count of how many assets have each combination.
// Query: one or more ?field=FieldName params (order preserved).
router.get('/asset-combinations', async (req, res, next) => {
  try {
    const fieldNames = [].concat(req.query.field || []).map(f => f.trim()).filter(Boolean);
    if (!fieldNames.length) return res.status(400).json({ error: 'at least one field param required' });

    const tables = await fetchBaseSchema();
    const assetsTable = tables.find(t => t.name === config.tables.assets);
    if (!assetsTable) throw new Error(`Assets table "${config.tables.assets}" not found`);

    // Build a type map and resolve linked-record ID→name maps up front
    const fieldDefs = {};
    for (const name of fieldNames) {
      const def = assetsTable.fields.find(f => f.name === name);
      if (def) fieldDefs[name] = def;
    }

    const linkedMaps = {};
    for (const name of fieldNames) {
      const def = fieldDefs[name];
      if (!def || def.type !== 'multipleRecordLinks') continue;
      const linkedTable = tables.find(t => t.id === def.options?.linkedTableId);
      if (!linkedTable) continue;
      const primaryField = linkedTable.fields[0]?.name ?? 'Name';
      const recs = await selectAll(linkedTable.name, { fields: [primaryField] });
      linkedMaps[name] = new Map(recs.map(r => [r.id, r.fields[primaryField] ?? r.id]));
    }

    // Fetch all asset records requesting only the variable fields
    const records = await selectAll(config.tables.assets, { fields: fieldNames });

    // Extract a display-name string for one field value in a record
    function resolveValue(name, raw) {
      if (raw == null) return null;
      const def = fieldDefs[name];
      if (!def) return String(raw);
      if (def.type === 'singleSelect') return raw;
      if (def.type === 'multipleSelects') return Array.isArray(raw) ? (raw[0] ?? null) : raw;
      if (def.type === 'multipleRecordLinks') {
        const id = Array.isArray(raw) ? raw[0] : raw;
        return id ? (linkedMaps[name]?.get(id) ?? id) : null;
      }
      // number, rating, lookup, rollup, etc.
      const v = Array.isArray(raw) ? raw[0] : raw;
      return v != null ? String(v) : null;
    }

    const comboCounts = new Map();
    for (const r of records) {
      const combo = {};
      let complete = true;
      for (const name of fieldNames) {
        const val = resolveValue(name, r.fields[name]);
        if (val == null) { complete = false; break; }
        combo[name] = val;
      }
      if (!complete) continue;

      const key = fieldNames.map(f => combo[f]).join('\x00');
      if (comboCounts.has(key)) {
        comboCounts.get(key).count++;
      } else {
        comboCounts.set(key, { values: combo, count: 1 });
      }
    }

    const combinations = [...comboCounts.values()].sort((a, b) => {
      for (const f of fieldNames) {
        const cmp = (a.values[f] ?? '').localeCompare(b.values[f] ?? '');
        if (cmp !== 0) return cmp;
      }
      return 0;
    });

    res.json({ combinations });
  } catch (err) {
    next(err);
  }
});

// Returns the full estimation matrix: Task Templates in workflow order × estimate combinations.
router.get('/matrix-table', async (req, res, next) => {
  try {
    const estimatesConfig = readEstimatesConfig();
    const variableFields = estimatesConfig._variableFields || [];
    // colName → pretty label from config
    const configColMap = new Map(
      Object.entries(estimatesConfig)
        .filter(([k]) => k !== '_variableFields')
        .map(([key, colName]) => [colName, key.replace(/\|/g, ' | ')])
    );

    // Use schema to discover linked tables for every multipleRecordLinks field on Task Templates,
    // then fetch those tables so we can resolve IDs → display names.
    const DEP_FIELDS = new Set(['Depends upon', 'Depended upon']);
    const tables = await fetchBaseSchema();
    const templatesSchema = tables.find(t => t.name === config.tables.templates);
    const linkedNameMaps = {}; // fieldName → Map<recordId, displayName>
    const attributeFields = []; // linked fields that are not dependency fields (shown as columns)
    if (templatesSchema) {
      for (const field of templatesSchema.fields) {
        if (field.type !== 'multipleRecordLinks') continue;
        const linkedTable = tables.find(t => t.id === field.options?.linkedTableId);
        if (!linkedTable) continue;
        const primaryField = linkedTable.fields[0]?.name ?? 'Name';
        const recs = await selectAll(linkedTable.name, { fields: [primaryField] });
        linkedNameMaps[field.name] = new Map(recs.map(r => [r.id, r.fields[primaryField] ?? r.id]));
        if (!DEP_FIELDS.has(field.name)) attributeFields.push(field.name);
      }
    }

    const templates = await selectAll(config.tables.templates);

    // Template name map used to resolve "Depends upon" linked record IDs → task names
    const templateNameMap = new Map(templates.map(t => [t.id, t.fields['Task'] || t.id]));

    // Helper: resolve an array of linked record IDs to display names
    function resolveLinked(raw, nameMap) {
      if (!raw || !Array.isArray(raw)) return [];
      return raw
        .map(l => { const id = typeof l === 'string' ? l : (l.id ?? null); return id ? (nameMap?.get(id) ?? null) : null; })
        .filter(Boolean);
    }

    // Build dependency graph: id → [follower ids] for topological sort
    const taskGraph = new Map();
    templates.forEach(t => {
      const followers = (t.fields['Depended upon'] || [])
        .map(l => (typeof l === 'string' ? l : (l.id ?? null)))
        .filter(Boolean);
      taskGraph.set(t.id, followers);
    });

    const visited = new Set();
    const sorted  = [];
    function visit(id) {
      if (visited.has(id)) return;
      visited.add(id);
      for (const dep of taskGraph.get(id) || []) visit(dep);
      sorted.push(id);
    }
    for (const id of taskGraph.keys()) visit(id);
    sorted.reverse(); // reverse → forward production order (step 1 = first task)

    // Discover all number fields on Task Templates from schema — these are estimate columns.
    // Merge with config: registered columns get their pretty label, others use the raw field name.
    const SKIP_FIELDS = new Set(['Task', ...DEP_FIELDS, ...attributeFields]);
    const combinations = [];
    if (templatesSchema) {
      for (const field of templatesSchema.fields) {
        if (SKIP_FIELDS.has(field.name)) continue;
        if (field.type !== 'number' && !configColMap.has(field.name)) continue;
        const label = configColMap.get(field.name) ?? field.name;
        combinations.push({ key: label, colName: field.name, label });
      }
    }
    // Fallback: if schema walk found nothing, use config entries
    if (!combinations.length) {
      for (const [colName, label] of configColMap) {
        combinations.push({ key: label, colName, label });
      }
    }

    const templateEntries = new Map(templates.map(t => [t.id, t]));
    const colNames = combinations.map(c => c.colName);

    const tasks = sorted.map((id, idx) => {
      const t = templateEntries.get(id);
      if (!t) return null;

      const dependsOn = resolveLinked(t.fields['Depends upon'], templateNameMap);

      // Resolve all attribute linked fields dynamically
      const linkedValues = {};
      for (const fieldName of attributeFields) {
        linkedValues[fieldName] = resolveLinked(t.fields[fieldName], linkedNameMaps[fieldName]);
      }

      const estimates = {};
      colNames.forEach(col => { const val = t.fields[col]; if (val != null) estimates[col] = val; });

      return { id, step: idx + 1, name: t.fields['Task'] || 'Untitled', linkedValues, dependsOn, estimates };
    }).filter(Boolean);

    res.json({ variableFields, combinations, tasks, attributeFields });
  } catch (err) {
    next(err);
  }
});

// Adds one number column per combination to the Task Templates table,
// then writes estimates.config.json with the generated mappings.
router.post('/create-matrix', async (req, res, next) => {
  try {
    const { variables, combinations, prefillCol = '', clearExisting = false } = req.body;
    // variables:    [{field, type}]
    // combinations: [{label, values: {fieldName: {id, name}}}]

    const variableFields = variables.map(v => v.field);

    const tables = await fetchBaseSchema();
    const templatesTable = tables.find(t => t.name === config.tables.templates);
    if (!templatesTable) throw new Error(`Templates table "${config.tables.templates}" not found`);

    let existingFieldNames = new Set(templatesTable.fields.map(f => f.name));
    const deleted = [];

    // If clearExisting, delete all fields from the previous config before creating new ones
    if (clearExisting) {
      const prevConfig = readEstimatesConfig();
      const prevColNames = Object.entries(prevConfig)
        .filter(([k]) => k !== '_variableFields')
        .map(([, v]) => v);
      for (const fieldName of prevColNames) {
        const field = templatesTable.fields.find(f => f.name === fieldName);
        if (field) {
          await deleteField(templatesTable.id, field.id);
          existingFieldNames.delete(fieldName);
          deleted.push(fieldName);
        }
      }
    }

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

    // Write estimates.config.json (JSON so node --watch doesn't treat it as a module)
    const configObj = { _variableFields: variableFields, ...configMap };
    fs.writeFileSync(ESTIMATES_CONFIG_PATH, JSON.stringify(configObj, null, 2), 'utf8');

    // Respond immediately so the browser is never left waiting on the prefill network calls.
    // Prefill runs after the response is sent; errors are caught and logged, never crash the server.
    const targetCols = [...created, ...skipped];
    const hasPrefill = !!(prefillCol && targetCols.length);

    res.json({
      templatesTable: templatesTable.name,
      created:     created.length,
      skipped:     skipped.length,
      deleted:     deleted.length,
      prefillPending: hasPrefill,
      columns:     created,
    });

    if (hasPrefill) {
      const tableId    = templatesTable.id;
      const delayMs    = created.length ? 2000 : 0;
      // Run prefill fully detached from the request so any undici/fetch crash
      // can't propagate back and kill the HTTP response or the Node process.
      setImmediate(() => {
        (async () => {
          if (delayMs) await new Promise(r => setTimeout(r, delayMs));
          const templates = await fetchRecordsDirect(tableId, [prefillCol]);
          console.log(`[prefill] source="${prefillCol}" targets=${targetCols.length} templates=${templates.length}`);
          const updates = [];
          for (const tmpl of templates) {
            const srcVal = tmpl.fields[prefillCol];
            if (srcVal == null) continue;
            const fields = {};
            for (const col of targetCols) fields[col] = srcVal;
            updates.push({ id: tmpl.id, fields });
          }
          console.log(`[prefill] sending ${updates.length} record updates`);
          if (updates.length) await patchRecords(tableId, updates);
          console.log('[prefill] done');
        })().catch(err => console.error('[prefill error]', err.message));
      });
    }
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

    const estimatesConfig = readEstimatesConfig();
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
    const estimatesConfig = readEstimatesConfig();
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
