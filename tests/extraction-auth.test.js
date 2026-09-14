import test from 'node:test';
import assert from 'node:assert/strict';
import { handler as extractResults } from '../netlify/functions/extract-results.mjs';

test('blocks AI extraction without an admin session', async () => {
  const response = await extractResults({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({})
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(JSON.parse(response.body), { error: 'Admin session required' });
});
