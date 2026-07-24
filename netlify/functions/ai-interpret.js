// netlify/functions/ai-interpret.js
// News sim AI proxy — returns currency strength scores for correlated pairs consistency
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const KEY_ENV = 'GEMINI_API_KEY';

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const apiKey = (process.env[KEY_ENV] || '').trim();
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GEMINI_API_KEY not configured' }) };
  }

  const events = payload.events || [];
  const pair = payload.pair || 'EUR/USD';

  const eventText = events.map((e, i) => `${i+1}. ${e.title} (${e.impact} impact, ${e.pair}) — Forecast: ${e.forecast||'N/A'}, Actual: ${e.actual||'N/A'}`).join('\n');

  const systemInstruction = `You are a forex news analyst. Given economic news events and a currency pair, judge the likely market reaction.

Reply with STRICT JSON only, matching this shape:
{
  "scenario": "Bullish" | "Bearish" | "Neutral" | "Range" | "High Volatility",
  "direction": "bullish" | "bearish" | "neutral",
  "volatility": <number 0.5-3.0>,
  "confidence": <integer 0-100>,
  "reasoning": "2-3 sentences plain English",
  "currencyEffects": {
    "EUR": <number -5 to 5>,
    "GBP": <number -5 to 5>,
    "USD": <number -5 to 5>,
    "JPY": <number -5 to 5>,
    "AUD": <number -5 to 5>,
    "CAD": <number -5 to 5>,
    "CHF": <number -5 to 5>,
    "NZD": <number -5 to 5>,
    "XAU": <number -5 to 5>,
    "BTC": <number -5 to 5>
  }
}

The "currencyEffects" field is CRITICAL. For each currency involved in the news, assign a strength score from -5 (very weak) to +5 (very strong). This ensures all pairs sharing a currency move consistently. If no news affects a currency, score it 0.

Example: If US NFP beats expectations, USD might be +3, EUR might be -1 (relative weakness), GBP -1, etc.
Example: If ECB hikes rates, EUR might be +4, USD -2, etc.

The "direction" field should be the net direction for the SPECIFIC pair requested, derived from the currency effects.

Keep reasoning concise, 2-3 sentences, plain English. Never claim certainty — use probabilities.`;

  const userContent = `Currency pair: ${pair}
News events:
${eventText}

Analyze the combined effect of these events on ${pair}. Provide currency strength scores for all major currencies so that correlated pairs move consistently.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userContent }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          scenario: { type: 'STRING', enum: ['Bullish','Bearish','Neutral','Range','High Volatility'] },
          direction: { type: 'STRING', enum: ['bullish','bearish','neutral'] },
          volatility: { type: 'NUMBER' },
          confidence: { type: 'INTEGER' },
          reasoning: { type: 'STRING' },
          currencyEffects: {
            type: 'OBJECT',
            properties: {
              EUR: { type: 'NUMBER' }, GBP: { type: 'NUMBER' }, USD: { type: 'NUMBER' },
              JPY: { type: 'NUMBER' }, AUD: { type: 'NUMBER' }, CAD: { type: 'NUMBER' },
              CHF: { type: 'NUMBER' }, NZD: { type: 'NUMBER' }, XAU: { type: 'NUMBER' }, BTC: { type: 'NUMBER' }
            }
          }
        },
        required: ['scenario','direction','volatility','confidence','reasoning','currencyEffects']
      }
    }
  };

  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: `Gemini API error (${res.status}): ${text.slice(0,300)}` }) };
    }
    const json = JSON.parse(text);
    const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return { statusCode: 502, body: JSON.stringify({ error: 'No content returned' }) };
    const cleaned = raw.replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(cleaned);

    // Validate
    const conf = Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(100, Math.round(parsed.confidence))) : 50;
    const vol = Number.isFinite(parsed.volatility) ? Math.max(0.5, Math.min(3, parsed.volatility)) : 1;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        scenario: parsed.scenario || 'Neutral',
        direction: parsed.direction || 'neutral',
        volatility: vol,
        confidence: conf,
        reasoning: parsed.reasoning || 'No reasoning provided.',
        currencyEffects: parsed.currencyEffects || {},
        ai: true
      })
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: e.message || 'Unknown error' }) };
  }
};
