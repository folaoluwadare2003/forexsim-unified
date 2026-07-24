// netlify/functions/finnhub-proxy.js
//
// Economic calendar via Forex Factory's public weekly JSON feed.
// No API key needed — this replaces the old Finnhub economic-calendar call,
// which requires a paid Finnhub plan that free-tier keys don't have access to.
//
// Source: https://nfs.faireconomy.media/ff_calendar_thisweek.json
// This is a long-standing free feed FF publishes for EA/bot developers. No
// auth, no rate limit key. Caveats:
//  - Weekly only (this week's events) — from/to params below just FILTER
//    that week's data, they can't reach further back/forward than it covers.
//  - The feed includes forecast/previous but not "actual" (actual updates
//    live on FF's site and isn't part of the static weekly file) — actual
//    will just come through blank, same as it would on a quiet pre-release day.
//  - It's an unofficial-but-widely-used community feed, not a formal SLA'd
//    API. If FF ever changes the shape/URL, this will need a small tweak —
//    same trade-off you already accepted with Finnhub before its plan
//    surprise.
//
// Kept the same file name, query params (from/to), and response shape
// (array of {id, event, impact, country, estimate, actual, time}) as the old
// Finnhub proxy — so index.html's API.finnhub() and loadCalendar() need ZERO
// changes.
const FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

exports.handler = async function (event) {
  const params = new URLSearchParams(event.queryStringParameters || {});
  const from = params.get('from') || new Date().toISOString().slice(0, 10);
  const to = params.get('to') || from;

  try {
    const res = await fetch(FEED_URL);
    const text = await res.text();
    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: 'FF calendar error: ' + text.slice(0, 200) }) };
    }

    let events;
    try {
      events = JSON.parse(text);
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: 'FF calendar returned non-JSON.' }) };
    }
    if (!Array.isArray(events)) {
      return { statusCode: 502, body: JSON.stringify({ error: 'FF calendar returned unexpected shape.' }) };
    }

    // Each event's "date" field arrives with its own UTC offset baked in
    // (e.g. "2026-07-24T13:30:00-04:00"), so new Date(e.date) parses to the
    // correct real-world instant with no manual timezone math needed — it
    // then serializes to a clean UTC ISO string below, same as before.
    const fromTime = new Date(from + 'T00:00:00Z').getTime();
    const toTime = new Date(to + 'T23:59:59Z').getTime();

    const filtered = events.filter(e => {
      const t = new Date(e.date).getTime();
      return Number.isFinite(t) && t >= fromTime && t <= toTime;
    });

    const mapped = filtered.map((e, i) => ({
      id: `ff_${i}_${e.date}`,
      event: e.title || 'Economic Event',
      impact: e.impact || 'Low',
      country: e.country || 'USD',
      estimate: e.forecast || '',
      actual: e.actual || '',
      time: new Date(e.date).toISOString()
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(mapped)
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: e.message }) };
  }
};
