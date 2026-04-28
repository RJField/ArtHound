const { selectAll, findRecord } = require('./airtable');
const config = require('../config');
const ESTIMATES = require('../estimates.config');

// Handles lookup arrays of strings, linked-record objects, collaborators, and plain strings
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

// Returns the record ID from a linked-record field value (object or raw string)
function linkId(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.id ?? null;
}

function reverseTopologicalSort(graph) {
  const visited = new Set();
  const sorted = [];
  function visit(node) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const next of graph.get(node) || []) {
      if (graph.has(next)) visit(next);
    }
    sorted.push(node);
  }
  for (const node of graph.keys()) visit(node);
  return sorted;
}

async function buildSchedule(assetId) {
  // Pre-fetch Item Types so we can resolve linked record IDs → names
  const itemTypeRecords = await selectAll(config.tables.itemTypes);
  const itemTypeNames = new Map(
    itemTypeRecords.map(r => [r.id, r.fields['Item'] ?? r.id])
  );

  const asset = await findRecord(config.tables.assets, assetId);
  if (!asset) throw new Error('Asset not found');

  const f = field => asset.fields[field] ?? null;

  // Item Type is a linked record — REST API returns [{id}] or ["recXXX"]
  const itemTypeLinks = f('Item Type') || [];
  const assetItemId   = linkId(itemTypeLinks[0]);
  if (!assetItemId) throw new Error('Asset has no Item Type linked');
  const assetItemName = itemTypeNames.get(assetItemId);
  if (!assetItemName) throw new Error(`Item Type ID ${assetItemId} not found in Item Types table`);

  if (!f('Product')) throw new Error('Asset is not linked to a product');

  const strategicPriority = f('Priority');
  if (strategicPriority == null) throw new Error('Priority is not set on the asset');

  // Milestone 4 is a lookup field — returns an array of date strings e.g. ["2026-07-17"]
  const milestone4 = f('Milestone 4 [Dates]');
  const dateRaw     = Array.isArray(milestone4) ? milestone4[0] : milestone4;
  const projectDate = dateRaw ? new Date(dateRaw) : null;
  if (!projectDate) throw new Error('Milestone 4 date is not set — cannot schedule backwards');

  // Resolve any asset field to a plain string for the estimate key
  function resolveFieldValue(raw) {
    if (raw == null) return '';
    if (Array.isArray(raw)) {
      if (!raw[0]) return '';
      const id = linkId(raw[0]);
      if (id && itemTypeNames.has(id)) return itemTypeNames.get(id);
      const name = resolveName(raw);
      return name != null ? String(name) : '';
    }
    return String(raw);
  }

  // Build lookup key from _variableFields — e.g. "Mace|Maps|1"
  const varFields  = ESTIMATES._variableFields || [];
  const estimateKey = varFields.map(fn => resolveFieldValue(f(fn))).join('|');
  const assetTeam  = resolveFieldValue(f('Team (from Product)'));

  const templates = await selectAll(config.tables.templates);

  const taskGraph     = new Map();
  const taskEstimates = new Map();
  const taskInfo      = new Map();

  for (const template of templates) {
    const tf = field => template.fields[field] ?? null;
    const templateId = template.id;

    const templateItemTypes = tf('Item Type') || [];
    const matchesItem = !Array.isArray(templateItemTypes)
      || templateItemTypes.length === 0
      || templateItemTypes.some(l => linkId(l) === assetItemId);
    if (!matchesItem) continue;

    const colName  = ESTIMATES[estimateKey] ?? null;
    const estimate = colName ? (tf(colName) ?? 0) : 0;
    taskEstimates.set(templateId, estimate);

    const craftLinks  = tf('Craft') || [];
    const capCraftIds = Array.isArray(craftLinks) ? craftLinks.map(l => linkId(l)).filter(Boolean) : [];
    taskInfo.set(templateId, {
      taskName:    tf('Task') || 'Untitled',
      craft:       resolveName(craftLinks[0]) ?? '',
      capCraftIds,
    });

    const followedBy = (tf('Depended upon') || []).map(l => linkId(l)).filter(Boolean);
    taskGraph.set(templateId, followedBy);
  }

  const sortedIds = reverseTopologicalSort(taskGraph);
  const taskDates = new Map();

  for (const templateId of sortedIds) {
    const followers = taskGraph.get(templateId) || [];
    const estimate  = taskEstimates.get(templateId) ?? 0;
    let endDate = new Date(projectDate);

    if (followers.length > 0) {
      const followerStarts = followers.map(id => taskDates.get(id)?.startDate).filter(Boolean);
      if (followerStarts.length > 0) {
        endDate = new Date(followerStarts.reduce((a, b) => (b < a ? b : a)));
      }
    }

    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - estimate);
    taskDates.set(templateId, { startDate, endDate });
  }

  const assetName = resolveName(f('Name')) ?? assetId;
  const tasks = [];

  for (const templateId of sortedIds) {
    const info     = taskInfo.get(templateId);
    if (!info) continue;
    const estimate = taskEstimates.get(templateId);
    if (!estimate || estimate <= 0) continue;

    const { startDate, endDate } = taskDates.get(templateId);
    tasks.push({
      templateId,
      taskName:    `${info.taskName} - ${assetName} - ${info.craft}`,
      craft:       info.craft,
      capCraftIds: info.capCraftIds,
      estimate,
      startDate:   startDate.toISOString().split('T')[0],
      endDate:     endDate.toISOString().split('T')[0],
    });
  }

  return {
    asset: {
      id:          assetId,
      name:        assetName,
      itemType:    assetItemName,
      team:        assetTeam,
      priority:    strategicPriority,
      projectDate: projectDate.toISOString().split('T')[0],
    },
    tasks,
  };
}

module.exports = { buildSchedule };
