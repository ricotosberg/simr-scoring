export async function extractResultsFromImage({ imageBase64, mediaType, roster, sessionKind }) {
  const response = await fetch('/.netlify/functions/extract-results', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64, mediaType, roster, sessionKind })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Extraction failed (${response.status})`);
  }
  if (!Array.isArray(payload.results)) {
    throw new Error('Extraction returned an invalid result');
  }
  return payload.results;
}
