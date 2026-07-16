const COST_KEY_PRIORITY = new Map([
  ['totalcostusd', 4],
  ['total_cost_usd', 4],
  ['totalcost', 3],
  ['total_cost', 3],
  ['costusd', 2],
  ['cost_usd', 2],
  ['cost', 1],
]);

function explicitAttemptCost(usage) {
  const candidates = [];
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 8) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const normalized = String(key).replace(/[-\s]/g, '_').toLowerCase();
      const compact = normalized.replace(/_/g, '');
      const priority = COST_KEY_PRIORITY.get(normalized) || COST_KEY_PRIORITY.get(compact) || 0;
      const number = Number(item);
      if (priority && Number.isFinite(number) && number >= 0) candidates.push({ priority, value: number });
      else visit(item, depth + 1);
    }
  };
  visit(usage);
  if (!candidates.length) return null;
  candidates.sort((left, right) => right.priority - left.priority);
  return candidates[0].value;
}

function explicitRunCost(attempts) {
  let total = 0;
  let observed = false;
  for (const attempt of attempts || []) {
    const cost = explicitAttemptCost(attempt?.usage);
    if (cost == null) continue;
    total += cost;
    observed = true;
  }
  return observed ? total : null;
}

module.exports = { explicitAttemptCost, explicitRunCost };
