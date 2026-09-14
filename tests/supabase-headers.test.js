import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseHeaders } from '../src/api/supabase-headers.js';

test('sends a modern Supabase publishable key only as apikey', () => {
  const headers = createSupabaseHeaders('sb_publishable_test-value');
  assert.equal(headers.apikey, 'sb_publishable_test-value');
  assert.equal(Object.hasOwn(headers, 'Authorization'), false);
});

test('retains Authorization for a legacy anon JWT', () => {
  const headers = createSupabaseHeaders('legacy-jwt-value');
  assert.equal(headers.apikey, 'legacy-jwt-value');
  assert.equal(headers.Authorization, 'Bearer legacy-jwt-value');
});
