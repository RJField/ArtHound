const express = require('express');
const config = require('../config');

const router = express.Router();

// Maps Airtable field types to display categories for color-coding in the UI
const FIELD_CATEGORY = {
  singleLineText: 'text',  multilineText: 'text',  richText: 'text',
  email: 'text',  url: 'text',  phoneNumber: 'text',
  number: 'number',  percent: 'number',  currency: 'number',
  rating: 'number',  duration: 'number',  autoNumber: 'number',
  date: 'date',  dateTime: 'date',  createdTime: 'date',  lastModifiedTime: 'date',
  multipleRecordLinks: 'link',
  formula: 'computed',  rollup: 'computed',  count: 'computed',  lookup: 'computed',
  singleSelect: 'select',  multipleSelects: 'select',
  checkbox: 'bool',
  collaborator: 'user',  multipleCollaborators: 'user',
  createdBy: 'user',  lastModifiedBy: 'user',
  multipleAttachments: 'file',
};

router.get('/', async (req, res, next) => {
  try {
    const { AIRTABLE_TOKEN, AIRTABLE_BASE_ID } = process.env;
    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
      throw new Error('AIRTABLE_TOKEN and AIRTABLE_BASE_ID must be set in .env');
    }

    const r = await fetch(
      `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );

    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error?.message || `Metadata API returned ${r.status}. Ensure your token has the "schema.bases:read" scope.`);
    }

    const { tables } = await r.json();
    const byName = Object.fromEntries(tables.map(t => [t.name, t]));

    const configured = Object.entries(config.tables).map(([key, name]) => {
      const table = byName[name];
      return {
        key,
        name,
        found:  !!table,
        id:     table?.id ?? null,
        fields: (table?.fields ?? []).map(f => ({
          id:       f.id,
          name:     f.name,
          type:     f.type,
          category: FIELD_CATEGORY[f.type] ?? 'other',
        })),
      };
    });

    // Also expose all table names in the base so the user can spot mismatches
    const allTableNames = tables.map(t => t.name);

    res.json({ configured, allTableNames });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
