import { hasValidSession } from './_shared/admin-session.mjs';

const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALLOWED_SESSION_KINDS = new Set(['qualifying', 'grid', 'race']);
const MAX_IMAGE_BASE64_LENGTH = 6_500_000;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function buildInstructions(sessionKind, roster) {
  const sessionLabel = sessionKind === 'qualifying'
    ? 'QUALIFYING session'
    : sessionKind === 'grid'
      ? 'GRID/STARTING ORDER session'
      : 'RACE session';

  const details = sessionKind === 'qualifying'
    ? 'Extract driver names and lap times. P1 is pole position.'
    : sessionKind === 'grid'
      ? 'Extract driver names and starting grid positions only. No times are needed.'
      : 'Extract driver names, finishing positions, best lap time per driver when visible, and DNFs. Use BESTLAP/Best Lap/Best Time, never LASTLAP, DELTA, Gap, or CAR.';

  return `Extract results from this screenshot for a ${sessionLabel}.
${details}
The screenshot may be a traditional results screen or a simulator lobby listing drivers in order.
Known driver roster: ${roster.join(', ')}.
Match names using exact, partial, or supplied alias text.
Return only a JSON array sorted by position. Each object must have:
{"position": number, "driver_name": string, "lap_time": string|null, "dnf": boolean}`;
}

export const handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!hasValidSession(event.headers)) return json(401, { error: 'Admin session required' });
  if (!process.env.ANTHROPIC_API_KEY) return json(500, { error: 'AI extraction is not configured' });

  let input;
  try {
    input = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { imageBase64, mediaType, roster, sessionKind } = input;
  if (!imageBase64 || typeof imageBase64 !== 'string') return json(400, { error: 'Image is required' });
  if (imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
    return json(413, { error: 'Image is too large. Save or export it below 4.8 MB and try again.' });
  }
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) return json(400, { error: 'Unsupported image type' });
  if (!ALLOWED_SESSION_KINDS.has(sessionKind)) return json(400, { error: 'Invalid session type' });
  if (!Array.isArray(roster) || roster.length > 250) return json(400, { error: 'Invalid roster' });

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: buildInstructions(sessionKind, roster.map(String)) }
          ]
        }]
      })
    });
  } catch (error) {
    console.error('Anthropic network request failed', error?.message);
    return json(502, { error: 'Could not connect to the AI provider. Try again shortly.' });
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const type = typeof data?.error?.type === 'string' ? data.error.type : 'unknown_error';
    const message = typeof data?.error?.message === 'string'
      ? data.error.message.slice(0, 300)
      : 'No additional details were returned.';
    console.error('Anthropic request failed', response.status, type, message);
    return json(502, {
      error: `AI provider request failed (${response.status} ${type}): ${message}`
    });
  }

  try {
    const text = data.content?.find(item => item.type === 'text')?.text || '[]';
    const results = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!Array.isArray(results)) throw new Error('Expected an array');
    return json(200, { results });
  } catch {
    return json(502, { error: 'AI response was not valid result data' });
  }
};
