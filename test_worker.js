/**
 * Integration tests for the URL Shortener Worker
 * Run with: npx cf dev (in one terminal), then node test_worker.js
 *
 * Or run tests against your deployed worker:
 *   BASE_URL=https://yourdomain.com API_KEY=your-key node test_worker.js
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:8787';
const API_KEY = process.env.API_KEY || 'test-key';

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${API_KEY}`,
};

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function runTests() {
  console.log('\n🧪 URL Shortener Worker Tests\n');

  const testCode = `test-${Date.now()}`;

  // Create
  console.log('📌 Create short URL');
  let created;
  await test('POST /api/shorten creates a URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: 'https://www.iamdevbox.com/posts/building-self-hosted-url-shortener-cloudflare-workers/',
        code: testCode,
        campaign: 'test',
        notes: 'Integration test',
      }),
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    created = await resp.json();
    assert(created.code === testCode, `Expected code ${testCode}, got ${created.code}`);
    assert(created.shortUrl.includes(`/s/${testCode}`), 'shortUrl should include the code');
  });

  await test('POST /api/shorten rejects duplicate code', async () => {
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://example.com/', code: testCode }),
    });
    assert(resp.status === 409, `Expected 409 Conflict, got ${resp.status}`);
  });

  await test('POST /api/shorten requires authentication', async () => {
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/' }),
    });
    assert(resp.status === 401, `Expected 401, got ${resp.status}`);
  });

  await test('POST /api/shorten rejects non-http(s) URLs', async () => {
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'javascript:alert(1)' }),
    });
    assert(resp.status === 400, `Expected 400, got ${resp.status}`);
  });

  await test('POST /api/shorten rejects codes with reserved characters', async () => {
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://example.com/', code: 'apikey:evil' }),
    });
    assert(resp.status === 400, `Expected 400, got ${resp.status}`);
  });

  await test('POST /api/shorten rejects non-boolean block_bots', async () => {
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://example.com/', block_bots: 'yes' }),
    });
    assert(resp.status === 400, `Expected 400, got ${resp.status}`);
  });

  await test('block_bots URL serves a Turnstile challenge instead of redirecting', async () => {
    const bbCode = `${testCode}-bb`;
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://example.com/protected', code: bbCode, block_bots: true }),
    });
    // 501 when TURNSTILE_* secrets are not configured on this worker
    if (resp.status === 501) return;
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    try {
      const get = await fetch(`${BASE_URL}/s/${bbCode}`, { redirect: 'manual' });
      assert(get.status === 200, `Expected challenge page (200), got ${get.status}`);
      assert((await get.text()).includes('cf-turnstile'), 'Expected Turnstile widget');
      const post = await fetch(`${BASE_URL}/s/${bbCode}`, {
        method: 'POST', redirect: 'manual', body: new URLSearchParams({ 'cf-turnstile-response': 'invalid' }),
      });
      assert(post.status === 403, `Expected invalid token to be rejected with 403, got ${post.status}`);
    } finally {
      await fetch(`${BASE_URL}/api/urls/${bbCode}`, { method: 'DELETE', headers });
      await fetch(`${BASE_URL}/api/urls/${bbCode}/permanent`, { method: 'DELETE', headers });
    }
  });

  // Signup / OAuth
  console.log('\n🔑 Self-service signup');
  await test('GET /signup serves the signup page', async () => {
    const resp = await fetch(`${BASE_URL}/signup`);
    // 200 when at least one OAuth provider is configured, 501 otherwise
    assert([200, 501].includes(resp.status), `Expected 200 or 501, got ${resp.status}`);
    const contentType = resp.headers.get('Content-Type') || '';
    assert(contentType.includes('text/html'), `Expected HTML, got ${contentType}`);
  });

  await test('GET /auth/google/login redirects to Google (or 501 if unconfigured)', async () => {
    const resp = await fetch(`${BASE_URL}/auth/google/login`, { redirect: 'manual' });
    assert([302, 501].includes(resp.status), `Expected 302 or 501, got ${resp.status}`);
    if (resp.status === 302) {
      const location = resp.headers.get('Location') || '';
      assert(location.startsWith('https://accounts.google.com/'), `Unexpected Location: ${location}`);
      const cookie = resp.headers.get('Set-Cookie') || '';
      assert(cookie.includes('oauth_state='), 'Should set oauth_state cookie');
    }
  });

  await test('GET /auth/google/callback without state cookie is rejected', async () => {
    const resp = await fetch(`${BASE_URL}/auth/google/callback?state=abc&code=fake`, { redirect: 'manual' });
    assert([400, 501].includes(resp.status), `Expected 400 or 501, got ${resp.status}`);
  });

  await test('GET /s/{code} rejects reserved-prefix codes', async () => {
    const resp = await fetch(`${BASE_URL}/s/apikey:foo`, { redirect: 'manual' });
    assert(resp.status === 400, `Expected 400, got ${resp.status}`);
  });

  // Path/query passthrough
  console.log('\n↪️  Path and query passthrough');
  const ptFixtures = {
    base: 'https://example.com/base/?keep=1&view=home#frag',
    page: 'https://example.com/page?q=hello%20world',
    origin: 'https://example.com/',
  };
  const ptCodes = {};
  for (const [name, target] of Object.entries(ptFixtures)) {
    const code = `pt-${name}-${Date.now()}`;
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: target, code, campaign: 'test' }),
    });
    if (resp.status === 200) ptCodes[name] = code;
    else console.log(`  ⚠️  could not create passthrough fixture ${name}: ${resp.status}`);
  }
  const ptCases = [
    ['base', '', ptFixtures.base],
    ['base', '/x/y', 'https://example.com/base/x/y?keep=1&view=home#frag'],
    ['base', '//x', 'https://example.com/base/x?keep=1&view=home#frag'],
    ['base', '?view=admin', 'https://example.com/base/?keep=1&view=admin#frag'],
    ['base', '/x?a=1&a=2', 'https://example.com/base/x?keep=1&view=home&a=1&a=2#frag'],
    ['page', '/', 'https://example.com/page/?q=hello%20world'],
    ['page', '/extra?z=1', 'https://example.com/page/extra?q=hello%20world&z=1'],
    ['origin', '/?view=admin__system_configuration', 'https://example.com/?view=admin__system_configuration'],
  ];
  for (const [name, suffix, expected] of ptCases) {
    await test(`GET /s/{${name}}${suffix} → ${expected}`, async () => {
      assert(ptCodes[name], `fixture ${name} missing`);
      const resp = await fetch(`${BASE_URL}/s/${ptCodes[name]}${suffix}`, { redirect: 'manual' });
      assert(resp.status === 302, `Expected 302, got ${resp.status}`);
      const location = resp.headers.get('Location');
      assert(location === expected, `Expected ${expected}, got ${location}`);
    });
  }
  await test('GET /s/{code}x (unknown code) returns 404', async () => {
    assert(ptCodes.base, 'fixture base missing');
    const resp = await fetch(`${BASE_URL}/s/${ptCodes.base}x/y`, { redirect: 'manual' });
    assert(resp.status === 404, `Expected 404, got ${resp.status}`);
  });
  for (const code of Object.values(ptCodes)) {
    await fetch(`${BASE_URL}/api/urls/${code}`, { method: 'DELETE', headers });
    await fetch(`${BASE_URL}/api/urls/${code}/permanent`, { method: 'DELETE', headers });
  }

  // List
  console.log('\n📋 List URLs');
  await test('GET /api/urls returns list', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls`, { headers });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const data = await resp.json();
    assert(Array.isArray(data.urls), 'urls should be an array');
    assert(typeof data.total === 'number', 'total should be a number');
  });

  await test('GET /api/urls requires authentication', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls`);
    assert(resp.status === 401, `Expected 401, got ${resp.status}`);
  });

  // Update
  console.log('\n✏️  Update URL');
  await test('PUT /api/urls/{code} updates URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/${testCode}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ campaign: 'updated-test' }),
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const updated = await resp.json();
    assert(updated.campaign === 'updated-test', 'Campaign should be updated');
  });

  // Delete & Restore
  console.log('\n🗑️  Delete and Restore');
  await test('DELETE /api/urls/{code} soft-deletes URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/${testCode}`, {
      method: 'DELETE',
      headers,
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const data = await resp.json();
    assert(data.deleted === true, 'deleted should be true');
  });

  await test('GET /api/urls/deleted shows deleted URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/deleted`, { headers });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const data = await resp.json();
    const found = data.urls.find((u) => u.code === testCode);
    assert(found, `Deleted URL ${testCode} should appear in deleted list`);
  });

  await test('POST /api/urls/{code}/restore restores URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/${testCode}/restore`, {
      method: 'POST',
      headers,
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const data = await resp.json();
    assert(data.restored === true, 'restored should be true');
  });

  // Permanent delete (cleanup)
  console.log('\n💀 Permanent Delete');
  await test('DELETE /api/urls/{code} soft-deletes before permanent delete', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/${testCode}`, {
      method: 'DELETE',
      headers,
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
  });

  await test('DELETE /api/urls/{code}/permanent permanently removes URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/${testCode}/permanent`, {
      method: 'DELETE',
      headers,
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const data = await resp.json();
    assert(data.permanentlyDeleted === true, 'permanentlyDeleted should be true');
  });

  // Summary
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
