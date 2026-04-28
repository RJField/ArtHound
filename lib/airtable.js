const Airtable = require('airtable');

let _base = null;

function getBase() {
  if (_base) return _base;
  if (!process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID) {
    throw new Error('AIRTABLE_TOKEN and AIRTABLE_BASE_ID must be set in .env');
  }
  _base = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN })
    .base(process.env.AIRTABLE_BASE_ID);
  return _base;
}

async function selectAll(tableName, options = {}) {
  return getBase()(tableName).select(options).all();
}

async function findRecord(tableName, recordId) {
  return getBase()(tableName).find(recordId);
}

// Airtable limits batch creates to 10 records per request
async function createRecords(tableName, fieldsList) {
  const base = getBase();
  const results = [];
  for (let i = 0; i < fieldsList.length; i += 10) {
    const batch = fieldsList.slice(i, i + 10).map(fields => ({ fields }));
    const created = await base(tableName).create(batch);
    results.push(...created);
  }
  return results;
}

// Airtable limits batch updates to 10 records per request
async function updateRecords(tableName, updates) {
  // updates: [{id, fields}]
  const base = getBase();
  const results = [];
  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    const updated = await base(tableName).update(batch);
    results.push(...updated);
  }
  return results;
}

module.exports = { selectAll, findRecord, createRecords, updateRecords };
