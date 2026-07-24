// netlify/functions/finnhub-proxy.js
exports.handler = async function(event) {
  const key = (process.env.FINNHUB_KEY || '').trim();
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: 'FINNHUB_KEY not configured' }) };
  }

  const params = new URLSearchParams(event.queryStringParameters || {});
  const from = params.get('from') || new Date().toISOString().slice(0,10);
  const to = params.get('to') || from;

  const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${key}`;

  try {
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: 'Finnhub error: ' + text.slice(0,200) }) };
    }
    const data = JSON.parse(text);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(data.economicCalendar || [])
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: e.message }) };
  }
};
