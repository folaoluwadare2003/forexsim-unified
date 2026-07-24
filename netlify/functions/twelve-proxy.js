// netlify/functions/twelve-proxy.js
// Server-side TwelveData proxy. Keys stored in env var only.

const KEY_ENV = 'TWELVEDATA_KEYS';
const BATCH_SIZE = 4;

// Module-scope state: Netlify/Lambda reuses a warm function instance across
// back-to-back invocations, so keeping this outside the handler lets "dead"
// key status and request counts survive between refreshes instead of being
// thrown away every call. It still resets on a cold start — there's no way
// around that without an external store, so treat it as "best known state
// this instance has seen," not a durable record.
let keyState = null; // rebuilt to match rawKeys.length on first call / key-count change
let statsSinceColdStart = { requests: 0, refreshCount: 0 };

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const symbols = payload.symbols || [];
  const interval = payload.interval || '1h';
  const outputsize = payload.outputsize || 120;

  const rawKeys = (process.env[KEY_ENV] || '').split(',').map(k => k.trim()).filter(Boolean);
  if (!rawKeys.length) {
    return { statusCode: 500, body: JSON.stringify({ error: 'TWELVEDATA_KEYS not configured' }) };
  }

  // Track key state (persisted at module scope — see comment above)
  let keyIdx = 0;
  if (!keyState || keyState.length !== rawKeys.length) {
    keyState = rawKeys.map(() => ({ dead: false, lastUsed: 0 }));
  }
  let requestsThisCall = 0;

  function nextKey() {
    for (let i = 0; i < rawKeys.length; i++) {
      const idx = (keyIdx + i) % rawKeys.length;
      if (!keyState[idx].dead) return idx;
    }
    return -1;
  }

  const results = {};
  const batches = [];
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    batches.push(symbols.slice(i, i + BATCH_SIZE));
  }

  for (const batch of batches) {
    const symParam = batch.join(',');
    let success = false;
    let attempts = 0;

    while (!success && attempts < rawKeys.length) {
      const kIdx = nextKey();
      if (kIdx === -1) break;
      attempts++;
      keyIdx = kIdx;

      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symParam)}&interval=${interval}&outputsize=${outputsize}&apikey=${rawKeys[kIdx]}`;
      try {
        const res = await fetch(url, { method: 'GET' });
        requestsThisCall++;
        const text = await res.text();

        if (!res.ok) {
          if (res.status === 429) {
            // Rate limited — try next key
            keyState[kIdx].lastUsed = Date.now();
            keyIdx = (keyIdx + 1) % rawKeys.length;
            continue;
          }
          if (text.toLowerCase().includes('daily') || text.toLowerCase().includes('quota')) {
            keyState[kIdx].dead = true;
          }
          keyIdx = (keyIdx + 1) % rawKeys.length;
          continue;
        }

        const data = JSON.parse(text);
        // TwelveData returns either single object or array for multiple symbols
        if (Array.isArray(data)) {
          data.forEach(item => {
            if (item && item.values) results[item.meta?.symbol || item.symbol || batch[0]] = item;
          });
        } else if (data.values) {
          // Single symbol response
          results[batch[0]] = data;
        } else if (typeof data === 'object') {
          // Keyed by symbol
          Object.keys(data).forEach(sym => {
            if (data[sym] && data[sym].values) results[sym] = data[sym];
          });
        }
        success = true;
      } catch (e) {
        console.error('[TwelveProxy] Error:', e.message);
        keyIdx = (keyIdx + 1) % rawKeys.length;
      }
    }

    if (!success) {
      batch.forEach(sym => { results[sym] = null; });
    }
  }

  statsSinceColdStart.requests += requestsThisCall;
  statsSinceColdStart.refreshCount += 1;

  results.__meta = {
    totalKeys: rawKeys.length,
    activeKeys: keyState.filter(k => !k.dead).length,
    deadKeyIndexes: keyState.map((k, i) => k.dead ? i : -1).filter(i => i >= 0),
    requestsThisCall,
    symbolsRequested: symbols.length,
    batchSize: BATCH_SIZE,
    // best-known totals since this function instance was last cold-started —
    // resets on cold start, so treat as an indicator, not an exact lifetime count
    instanceRequestsTotal: statsSinceColdStart.requests,
    instanceRefreshCount: statsSinceColdStart.refreshCount
  };

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(results)
  };
};
