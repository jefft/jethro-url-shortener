/**
 * Cloudflare Worker - Self-Hosted URL Shortener
 *
 * Features:
 * - Short URL redirects: /s/{code} → full URL
 * - Full CRUD API with Bearer token authentication
 * - Click analytics tracking
 * - Soft delete + restore + permanent delete
 * - Self-service API keys: /signup mints a create-scoped key via Google/GitHub OAuth
 *
 * Deploy: wrangler deploy
 * Companion article: https://www.iamdevbox.com/posts/building-self-hosted-url-shortener-cloudflare-workers/
 */

// KV namespace binding: URL_MAPPINGS
// Configure in wrangler.toml

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Short URL redirect: /s/{code}
    if (url.pathname.startsWith('/s/')) {
      return handleShortUrl(url, env, ctx);
    }

    // API: Create short URL (authenticated — admin or create)
    if (url.pathname === '/api/shorten' && request.method === 'POST') {
      return handleCreateShortUrl(request, env);
    }

    // API: Get click statistics (public)
    if (url.pathname.startsWith('/api/stats/')) {
      return handleGetStats(url, env);
    }

    // API: Key management (admin only)
    if (url.pathname === '/api/keys' && request.method === 'GET') {
      return handleListKeys(request, env);
    }
    if (url.pathname === '/api/keys' && request.method === 'POST') {
      return handleCreateKey(request, env);
    }
    if (url.pathname === '/api/keys/mine' && request.method === 'DELETE') {
      return handleDeleteOwnKey(request, env);
    }
    if (url.pathname.match(/^\/api\/keys\/([^/]+)$/) && request.method === 'DELETE') {
      return handleDeleteKey(request, url, env);
    }

    // API: Validate the current API key (authenticated)
    if (url.pathname === '/api/validate' && request.method === 'GET') {
      return handleValidateKey(request, env);
    }

    // API: List all active URLs (admin only)
    if (url.pathname === '/api/urls' && request.method === 'GET') {
      return handleListUrls(request, env);
    }

    // API: Update URL (admin only)
    if (url.pathname.startsWith('/api/urls/') && request.method === 'PUT') {
      return handleUpdateUrl(request, url, env, ctx);
    }

    // API: Restore deleted URL (admin only) — must be before generic DELETE
    if (url.pathname.match(/^\/api\/urls\/[^/]+\/restore$/) && request.method === 'POST') {
      return handleRestoreUrl(request, url, env, ctx);
    }

    // API: Permanently delete URL (admin only) — must be before generic DELETE
    if (url.pathname.match(/^\/api\/urls\/[^/]+\/permanent$/) && request.method === 'DELETE') {
      return handlePermanentDelete(request, url, env, ctx);
    }

    // API: List deleted URLs (admin only)
    if (url.pathname === '/api/urls/deleted' && request.method === 'GET') {
      return handleListDeletedUrls(request, env);
    }

    // API: Soft delete URL (admin only)
    if (url.pathname.startsWith('/api/urls/') && request.method === 'DELETE') {
      return handleDeleteUrl(request, url, env, ctx);
    }

    // Self-service signup: OAuth login → mint a create-scoped API key
    if (url.pathname === '/signup' && request.method === 'GET') {
      try {
        return handleSignupPage(url, env);
      } catch (e) {
        console.error('Signup page error:', e);
        return new Response('Signup error: ' + String(e.message || e), {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    }

    // Self-service signup: email magic-link flow
    if (url.pathname === '/signup' && request.method === 'POST') {
      return handleEmailSignup(request, url, env);
    }
    if (url.pathname === '/auth/email/callback' && request.method === 'GET') {
      return handleEmailCallback(request, url, env);
    }

    const oauthMatch = url.pathname.match(/^\/auth\/(google|github)\/(login|callback)$/);
    if (oauthMatch && request.method === 'GET') {
      return oauthMatch[2] === 'login'
        ? handleOAuthLogin(url, env, oauthMatch[1])
        : handleOAuthCallback(request, url, env, oauthMatch[1]);
    }

    return new Response('URL Shortener - see /api/* for endpoints', { status: 200 });
  },
};

/**
 * Redirect /s/{code} to the target URL
 */
async function handleShortUrl(url, env, ctx) {
  const code = url.pathname.split('/s/')[1];

  // Codes never contain ':' — reject early so reserved KV records
  // (apikey:, idx:, tok:, owner:) are unreachable via public routes
  if (!code || code.includes(':')) {
    return new Response('Invalid short URL', {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  try {
    const mapping = await env.URL_MAPPINGS.get(code, { type: 'json' });

    if (!mapping || mapping.deleted) {
      return new Response(null, {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    ctx.waitUntil(incrementStats(code, env));
    return new Response(null, {
      status: 302,
      headers: {
        Location: mapping.url,
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        'Cache-Tag': `redirect:${code}`,
      },
    });
  } catch (error) {
    console.error('Error handling short URL:', error);
    return new Response('Internal Server Error', {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

/**
 * POST /api/shorten — Create a new short URL
 * Body: { url, code?, campaign?, notes? }
 */
async function handleCreateShortUrl(request, env) {
  try {
    const { err: authErr, auth } = await requireCreate(request, env);
    if (authErr) return authErr;

    const body = await request.json();
    const { url: longUrl, code, notes } = body;

    if (!longUrl) {
      return jsonResponse({ error: 'url is required' }, 400);
    }

    const urlErr = validateTargetUrl(longUrl);
    if (urlErr) {
      return jsonResponse({ error: urlErr }, 400);
    }

    if (code !== undefined && code !== null && !isValidShortCode(code)) {
      return jsonResponse({ error: 'code must be 1-64 characters: letters, digits, hyphen or underscore' }, 400);
    }

    if (notes !== undefined && notes !== null && notes !== '') {
      if (typeof notes !== 'string') {
        return jsonResponse({ error: 'notes must be a string' }, 400);
      }
      if (notes.length > 500) {
        return jsonResponse({ error: 'notes must be 500 characters or less' }, 400);
      }
    }

    const campaign = body.campaign || 'general';

    if (typeof campaign !== 'string' || campaign.length > 64) {
      return jsonResponse({ error: 'campaign must be a string of at most 64 characters' }, 400);
    }

    // Check idempotency: same URL + campaign → same code
    const idxKey = await hashKey(longUrl, campaign);
    const existingIdx = await env.URL_MAPPINGS.get(`idx:${idxKey}`, { type: 'json' });
    if (existingIdx) {
      const existingMapping = await env.URL_MAPPINGS.get(existingIdx.code, { type: 'json' });
      if (existingMapping && !existingMapping.deleted) {
        const baseUrl = new URL(request.url).origin;
        return jsonResponse({
          shortUrl: `${baseUrl}/s/${existingIdx.code}`,
          code: existingIdx.code,
          longUrl: existingMapping.url,
          existing: true,
        });
      }
      // If it was soft-deleted, fall through and recreate
    }

    const shortCode = code || await generateShortCode(longUrl, campaign, env);

    const existingCode = await env.URL_MAPPINGS.get(shortCode);
    if (existingCode) {
      return jsonResponse({ error: 'Short code already exists' }, 409);
    }

    // Store reverse index for idempotency
    await env.URL_MAPPINGS.put(`idx:${idxKey}`, JSON.stringify({
      code: shortCode,
      url: longUrl,
      campaign,
    }));

    const mapping = {
      url: longUrl,
      campaign,
      created: new Date().toISOString(),
      stats: { total: 0 },
    };

    if (auth.owner) {
      mapping.createdBy = auth.owner;
    }
    if (auth.createdByCampaign) {
      mapping.createdByCampaign = auth.createdByCampaign;
    }

    if (notes && notes.trim()) {
      mapping.notes = notes.trim();
    }

    await env.URL_MAPPINGS.put(shortCode, JSON.stringify(mapping));

    const baseUrl = new URL(request.url).origin;
    return jsonResponse({
      shortUrl: `${baseUrl}/s/${shortCode}`,
      code: shortCode,
      longUrl,
    });
  } catch (error) {
    console.error('Error creating short URL:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * GET /api/stats/{code} — Get click statistics for a short URL
 */
async function handleGetStats(url, env) {
  const code = url.pathname.split('/api/stats/')[1];

  if (!code || code.includes(':')) {
    return jsonResponse({ error: 'Invalid code' }, 400);
  }

  try {
    const mapping = await env.URL_MAPPINGS.get(code, { type: 'json' });

    if (!mapping || mapping.deleted) {
      return jsonResponse({ error: 'Stats not found' }, 404);
    }

    const statsData = await env.URL_MAPPINGS.get(`stats:${code}`, { type: 'json' });
    const data = (statsData && typeof statsData.total === 'number') ? statsData : { total: 0 };
    const response = jsonResponse(data);
    // Workers Cache: 1 minute fresh, 5 minute stale-while-revalidate
    response.headers.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    response.headers.set('Cache-Tag', `stats:${code}`);
    return response;
  } catch (error) {
    console.error('Error getting stats:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * GET /api/urls — List all active (non-deleted) URLs
 */
async function handleListUrls(request, env) {
  const t0 = Date.now();
  const authErr = await requireAdmin(request, env);
  if (authErr) return authErr;

  try {
    const urls = [];
    let cursor = null;
    let pages = 0;
    let totalKeys = 0;

    do {
      const listResult = await env.URL_MAPPINGS.list({ cursor });
      pages++;
      totalKeys += listResult.keys.length;

      for (const key of listResult.keys) {
        if (key.name.includes(':')) continue; // skip reserved records (stats:, idx:, apikey:, tok:, owner:)

        const mapping = await env.URL_MAPPINGS.get(key.name, { type: 'json' });
        if (!mapping || mapping.deleted) continue;

        const statsData = await env.URL_MAPPINGS.get(`stats:${key.name}`, { type: 'json' });

        urls.push({
          code: key.name,
          url: mapping.url,
          campaign: mapping.campaign,
          created: mapping.created,
          stats: (statsData && typeof statsData.total === 'number') ? statsData : { total: 0 },
          ...(mapping.notes ? { notes: mapping.notes } : {}),
          ...(mapping.createdBy ? { createdBy: mapping.createdBy } : {}),
          ...(mapping.createdByCampaign ? { createdByCampaign: mapping.createdByCampaign } : {}),
        });
      }

      cursor = listResult.list_complete ? null : listResult.cursor;
    } while (cursor);

    urls.sort((a, b) => new Date(b.created) - new Date(a.created));
    console.log(`[listUrls] done: ${urls.length} URLs, ${pages} pages, ${totalKeys} total keys, ${Date.now() - t0}ms`);

    return jsonResponse({ urls, total: urls.length });
  } catch (error) {
    console.error('Error listing URLs:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * PUT /api/urls/{code} — Update URL, campaign, code, or notes
 */
async function handleUpdateUrl(request, url, env, ctx) {
  const authErr = await requireAdmin(request, env);
    if (authErr) return authErr;

  const oldCode = url.pathname.split('/api/urls/')[1];
  if (!oldCode) {
    return jsonResponse({ error: 'Invalid code' }, 400);
  }

  try {
    const existing = await env.URL_MAPPINGS.get(oldCode, { type: 'json' });
    if (!existing) {
      return jsonResponse({ error: 'Short URL not found' }, 404);
    }

    const body = await request.json();
    const { url: newUrl, campaign, code: newCode, notes } = body;

    if (newUrl) {
      const urlErr = validateTargetUrl(newUrl);
      if (urlErr) {
        return jsonResponse({ error: urlErr }, 400);
      }
    }

    if (newCode && !isValidShortCode(newCode)) {
      return jsonResponse({ error: 'code must be 1-64 characters: letters, digits, hyphen or underscore' }, 400);
    }

    if (campaign !== undefined && campaign !== null) {
      if (typeof campaign !== 'string' || campaign.length > 64) {
        return jsonResponse({ error: 'campaign must be a string of at most 64 characters' }, 400);
      }
    }

    if (notes !== undefined && notes !== null) {
      if (typeof notes !== 'string') {
        return jsonResponse({ error: 'notes must be a string' }, 400);
      }
      if (notes.length > 500) {
        return jsonResponse({ error: 'notes must be 500 characters or less' }, 400);
      }
    }

    const updated = {
      url: newUrl || existing.url,
      campaign: campaign !== undefined ? campaign : existing.campaign,
      created: existing.created,
      updated: new Date().toISOString(),
      stats: existing.stats || { total: 0 },
    };

    if (existing.deleted !== undefined) updated.deleted = existing.deleted;
    if (existing.createdBy) updated.createdBy = existing.createdBy;
    if (existing.createdByCampaign) updated.createdByCampaign = existing.createdByCampaign;

    if (notes !== undefined) {
      if (notes.trim()) updated.notes = notes.trim();
    } else if (existing.notes) {
      updated.notes = existing.notes;
    }

    if (newCode && newCode !== oldCode) {
      const existingNew = await env.URL_MAPPINGS.get(newCode);
      if (existingNew) {
        return jsonResponse({ error: 'New code already exists' }, 409);
      }

      await env.URL_MAPPINGS.put(newCode, JSON.stringify(updated));
      await env.URL_MAPPINGS.delete(oldCode);

      // Invalidate cache for both old and new codes
      purgeCacheForCode(ctx, oldCode);
      purgeCacheForCode(ctx, newCode);

      return jsonResponse({ code: newCode, oldCode, ...updated });
    }

    await env.URL_MAPPINGS.put(oldCode, JSON.stringify(updated));

    // Invalidate cache for the updated code
    purgeCacheForCode(ctx, oldCode);

    return jsonResponse({ code: oldCode, ...updated });
  } catch (error) {
    console.error('Error updating URL:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * DELETE /api/urls/{code} — Soft delete (marks deleted=true, preserves data)
 */
async function handleDeleteUrl(request, url, env, ctx) {
  const authErr = await requireAdmin(request, env);
    if (authErr) return authErr;

  const code = url.pathname.split('/api/urls/')[1];
  if (!code) {
    return jsonResponse({ error: 'Invalid code' }, 400);
  }

  try {
    const existing = await env.URL_MAPPINGS.get(code, { type: 'json' });
    if (!existing) {
      return jsonResponse({ error: 'Short URL not found' }, 404);
    }

    const updated = {
      ...existing,
      deleted: true,
      deletedAt: new Date().toISOString(),
    };

    await env.URL_MAPPINGS.put(code, JSON.stringify(updated));

    purgeCacheForCode(ctx, code);

    return jsonResponse({ deleted: true, code });
  } catch (error) {
    console.error('Error deleting URL:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * POST /api/urls/{code}/restore — Restore a soft-deleted URL
 */
async function handleRestoreUrl(request, url, env, ctx) {
  const authErr = await requireAdmin(request, env);
    if (authErr) return authErr;

  const match = url.pathname.match(/^\/api\/urls\/([^/]+)\/restore$/);
  const code = match ? match[1] : null;

  if (!code) {
    return jsonResponse({ error: 'Invalid code' }, 400);
  }

  try {
    const existing = await env.URL_MAPPINGS.get(code, { type: 'json' });
    if (!existing) {
      return jsonResponse({ error: 'Short URL not found' }, 404);
    }

    if (!existing.deleted) {
      return jsonResponse({ error: 'Short URL is not deleted' }, 400);
    }

    const restored = { ...existing, deleted: false, restoredAt: new Date().toISOString() };
    delete restored.deletedAt;

    await env.URL_MAPPINGS.put(code, JSON.stringify(restored));

    purgeCacheForCode(ctx, code);

    return jsonResponse({ restored: true, code, url: restored.url });
  } catch (error) {
    console.error('Error restoring URL:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * GET /api/urls/deleted — List all soft-deleted URLs
 */
async function handleListDeletedUrls(request, env) {
  const authErr = await requireAdmin(request, env);
    if (authErr) return authErr;

  try {
    const urls = [];
    let cursor = null;

    do {
      const listResult = await env.URL_MAPPINGS.list({ cursor });

      for (const key of listResult.keys) {
        if (key.name.includes(':')) continue; // skip reserved records (stats:, idx:, apikey:, tok:, owner:)

        const mapping = await env.URL_MAPPINGS.get(key.name, { type: 'json' });
        if (mapping && mapping.deleted) {
          const urlObj = {
            code: key.name,
            url: mapping.url,
            campaign: mapping.campaign,
            created: mapping.created,
            deletedAt: mapping.deletedAt,
          };
          if (mapping.notes) urlObj.notes = mapping.notes;
          if (mapping.createdBy) urlObj.createdBy = mapping.createdBy;
          if (mapping.createdByCampaign) urlObj.createdByCampaign = mapping.createdByCampaign;
          urls.push(urlObj);
        }
      }

      cursor = listResult.list_complete ? null : listResult.cursor;
    } while (cursor);

    urls.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));

    return jsonResponse({ urls, total: urls.length });
  } catch (error) {
    console.error('Error listing deleted URLs:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * DELETE /api/urls/{code}/permanent — Permanently delete from KV (irreversible)
 */
async function handlePermanentDelete(request, url, env, ctx) {
  const authErr = await requireAdmin(request, env);
    if (authErr) return authErr;

  const match = url.pathname.match(/^\/api\/urls\/([^/]+)\/permanent$/);
  const code = match ? match[1] : null;

  if (!code) {
    return jsonResponse({ error: 'Invalid code' }, 400);
  }

  try {
    const existing = await env.URL_MAPPINGS.get(code, { type: 'json' });
    if (!existing) {
      return jsonResponse({ error: 'Short URL not found' }, 404);
    }

    if (!existing.deleted) {
      return jsonResponse({ error: 'Only soft-deleted URLs can be permanently removed' }, 400);
    }

    await env.URL_MAPPINGS.delete(code);

    purgeCacheForCode(ctx, code);

    return jsonResponse({ permanentlyDeleted: true, code });
  } catch (error) {
    console.error('Error permanently deleting URL:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * Increment click stats in a separate KV key so clicks never rewrite the
 * URL mapping document.  This avoids the read-modify-write race where a
 * concurrent admin mutation (delete, update) could be reverted by a stats
 * write holding a stale copy of the mapping.
 *
 * Called via ctx.waitUntil — non-blocking for the redirect response.
 */
async function incrementStats(code, env) {
  try {
    const statsKey = `stats:${code}`;
    const existing = await env.URL_MAPPINGS.get(statsKey, { type: 'json' });
    const total = (existing && typeof existing.total === 'number') ? existing.total + 1 : 1;
    await env.URL_MAPPINGS.put(statsKey, JSON.stringify({ total }));
  } catch (error) {
    console.error('Error incrementing stats:', error);
  }
}

/**
 * Generate a deterministic short code from URL + campaign hash.
 * Uses the first 6 chars of SHA-256 hex digest.
 * Falls back to random if the deterministic code is taken (collision).
 */
async function generateShortCode(url, campaign, env) {
  const hk = await hashKey(url, campaign);       // 64-char hex SHA-256
  const detCode = hk.slice(0, 6);                // 16^6 ≈ 16M combinations
  const existing = await env.URL_MAPPINGS.get(detCode);
  if (!existing) return detCode;

  // Collision — fall back to random (rare)
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const LENGTH = 6;
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = Array.from(
      crypto.getRandomValues(new Uint8Array(LENGTH)),
      (b) => ALPHABET[b % ALPHABET.length]
    ).join('');
    const e = await env.URL_MAPPINGS.get(code);
    if (!e) return code;
  }
  throw new Error('Failed to generate unique short code');
}

/**
 * Hash URL + campaign for idempotency lookup.
 * Returns a hex string.
 */
async function hashKey(url, campaign) {
  return sha256Hex(`${url}::${campaign}`);
}

/**
 * SHA-256 of a string as lowercase hex.
 */
async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Short codes: 1-64 chars of [A-Za-z0-9_-].
 * Excludes ':' so user codes can never collide with reserved KV prefixes
 * (stats:, idx:, apikey:, tok:, owner:).
 */
function isValidShortCode(code) {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code);
}

/**
 * Validate a redirect target. Returns an error message or null (valid).
 */
function validateTargetUrl(u) {
  if (typeof u !== 'string' || u.length > 2048) {
    return 'url must be a string of at most 2048 characters';
  }
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return 'url must be an absolute URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'url must use http or https';
  }
  return null;
}

/**
 * Purge Workers Cache entries associated with a short code.
 * Purging is non-blocking via ctx.waitUntil.
 * Guards against ctx.cache being undefined (cache not enabled, older runtime, local dev).
 *
 * @param {object} ctx - ExecutionContext from the fetch handler
 * @param {string} code - The short URL code whose cache entries to purge
 */
function purgeCacheForCode(ctx, code) {
  if (!ctx || !ctx.cache || typeof ctx.cache.purge !== 'function') {
    console.warn('Workers Cache unavailable; skipping purge for', code);
    return;
  }
  const tags = [`redirect:${code}`, `stats:${code}`];
  ctx.waitUntil(
    ctx.cache.purge({ tags }).catch((err) => {
      console.error('Error purging cache for', code, err);
    })
  );
}

/**
 * Verify Bearer token API key. Returns { authorized, type, owner?, keyId? }.
 *
 * Bootstrap key (env.API_KEY, set via wrangler secret) always has admin access.
 * All other keys are looked up O(1) by SHA-256(token) → tok:{hash} → apikey:{id}.
 * There is no plaintext-token walk — keys are always stored hashed.
 */
async function verifyApiKey(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authorized: false };
  }
  const token = authHeader.slice(7);

  // Bootstrap key always has admin access
  if (env.API_KEY && token === env.API_KEY) {
    return { authorized: true, type: 'admin' };
  }

  // All other keys: O(1) lookup by token hash (two KV gets, no list walk)
  const tokenHash = await sha256Hex(token);
  const tokRef = await env.URL_MAPPINGS.get(`tok:${tokenHash}`, { type: 'json' });
  if (tokRef && tokRef.id) {
    const keyData = await env.URL_MAPPINGS.get(`apikey:${tokRef.id}`, { type: 'json' });
    if (keyData) {
      return { authorized: true, type: keyData.type, owner: keyData.owner, keyId: keyData.id, createdByCampaign: keyData.createdByCampaign };
    }
  }

  return { authorized: false };
}

/**
 * Require admin access. Returns 401/403 or null (pass).
 */
async function requireAdmin(request, env) {
  const auth = await verifyApiKey(request, env);
  if (!auth.authorized) return jsonResponse({ error: 'Unauthorized' }, 401);
  if (auth.type !== 'admin') return jsonResponse({ error: 'Forbidden: admin key required' }, 403);
  return null;
}

/**
 * Require create (or admin) access.
 * Returns { err, auth }: err is a 401/403 Response or null, auth identifies the caller.
 */
async function requireCreate(request, env) {
  const auth = await verifyApiKey(request, env);
  if (!auth.authorized) {
    return { err: jsonResponse({ error: 'Unauthorized' }, 401), auth };
  }
  if (auth.type !== 'admin' && auth.type !== 'create') {
    return { err: jsonResponse({ error: 'Forbidden: create key required' }, 403), auth };
  }
  return { err: null, auth };
}

/**
 * GET /api/keys — List all API keys (admin only)
 */
async function handleListKeys(request, env) {
  const err = await requireAdmin(request, env);
  if (err) return err;

  try {
    const apiKeys = [];
    const { keys } = await env.URL_MAPPINGS.list({ prefix: 'apikey:' });

    for (const key of keys) {
      const keyData = await env.URL_MAPPINGS.get(key.name, { type: 'json' });
      if (keyData) {
        apiKeys.push({
          id: keyData.id,
          type: keyData.type,
          label: keyData.label || '',
          created: keyData.created,
          tokenPrefix: keyData.tokenPrefix || (keyData.token ? keyData.token.slice(0, 8) + '...' : ''),
          ...(keyData.owner ? { owner: keyData.owner, ownerEmail: keyData.ownerEmail } : {}),
          ...(keyData.createdByCampaign ? { createdByCampaign: keyData.createdByCampaign } : {}),
        });
      }
    }

    apiKeys.sort((a, b) => new Date(a.created) - new Date(b.created));
    return jsonResponse(apiKeys);
  } catch (error) {
    console.error('Error listing keys:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * POST /api/keys — Create a new API key (admin only)
 * Body: { type: "admin"|"create", label: "..." }
 */
async function handleCreateKey(request, env) {
  const err = await requireAdmin(request, env);
  if (err) return err;

  try {
    const body = await request.json();
    const { type, label } = body;

    if (!type || !['admin', 'create'].includes(type)) {
      return jsonResponse({ error: 'type must be "admin" or "create"' }, 400);
    }
    if (label && (typeof label !== 'string' || label.length > 100)) {
      return jsonResponse({ error: 'label must be a string under 100 characters' }, 400);
    }

    const id = crypto.randomUUID();
    const token = 'cus_' + crypto.randomUUID().replace(/-/g, '');
    const tokenHash = await sha256Hex(token);
    const keyData = {
      id,
      type,
      label: label || '',
      tokenHash,
      tokenPrefix: token.slice(0, 8) + '...',
      created: new Date().toISOString(),
    };

    await env.URL_MAPPINGS.put(`apikey:${id}`, JSON.stringify(keyData));
    await env.URL_MAPPINGS.put(`tok:${tokenHash}`, JSON.stringify({ id }));

    return jsonResponse({
      id,
      token,        // Only returned once on creation
      type,
      label: label || '',
      created: keyData.created,
    }, 201);
  } catch (error) {
    console.error('Error creating key:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * DELETE /api/keys/{id} — Revoke an API key (admin only)
 */
async function handleDeleteKey(request, url, env) {
  const err = await requireAdmin(request, env);
  if (err) return err;

  const match = url.pathname.match(/^\/api\/keys\/([^/]+)$/);
  const id = match ? match[1] : null;
  if (!id) return jsonResponse({ error: 'Invalid key id' }, 400);

  try {
    const existing = await env.URL_MAPPINGS.get(`apikey:${id}`, { type: 'json' });
    if (!existing) {
      return jsonResponse({ error: 'Key not found' }, 404);
    }

    // Prevent deleting the bootstrap key via KV (can't delete env.API_KEY anyway)
    await env.URL_MAPPINGS.delete(`apikey:${id}`);
    if (existing.tokenHash) await env.URL_MAPPINGS.delete(`tok:${existing.tokenHash}`);
    if (existing.owner) await env.URL_MAPPINGS.delete(`owner:${existing.owner}`);
    return jsonResponse({ revoked: true, id });
  } catch (error) {
    console.error('Error deleting key:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * DELETE /api/keys/mine — Revoke the calling key (self-service deregistration).
 * Any valid key (admin, create, or self-service) can revoke itself.
 * The bootstrap env.API_KEY cannot be revoked this way.
 *
 * After deleting the key records, scans all URL mappings and scrubs any
 * createdBy / createdByCampaign attribution that matches this key's owner,
 * so that deregistration leaves no trace of the owner's identity or campaign.
 */
async function handleDeleteOwnKey(request, env) {
  const auth = await verifyApiKey(request, env);
  if (!auth.authorized) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  // Bootstrap key has no KV record — can't self-revoke.
  if (!auth.keyId) {
    return jsonResponse({ error: 'The bootstrap admin key cannot be revoked via the API' }, 400);
  }

  try {
    const existing = await env.URL_MAPPINGS.get(`apikey:${auth.keyId}`, { type: 'json' });
    const owner = existing?.owner || null;

    // Delete the key records.
    await env.URL_MAPPINGS.delete(`apikey:${auth.keyId}`);
    if (existing && existing.tokenHash) await env.URL_MAPPINGS.delete(`tok:${existing.tokenHash}`);
    if (owner) await env.URL_MAPPINGS.delete(`owner:${owner}`);

    // Scrub attribution from any URL this key created.
    if (owner) {
      let cursor = null;
      do {
        const listResult = await env.URL_MAPPINGS.list({ cursor });
        for (const key of listResult.keys) {
          if (key.name.includes(':')) continue;
          const mapping = await env.URL_MAPPINGS.get(key.name, { type: 'json' });
          if (!mapping || mapping.createdBy !== owner) continue;
          delete mapping.createdBy;
          delete mapping.createdByCampaign;
          await env.URL_MAPPINGS.put(key.name, JSON.stringify(mapping));
        }
        cursor = listResult.list_complete ? null : listResult.cursor;
      } while (cursor);
    }

    return jsonResponse({ revoked: true, id: auth.keyId });
  } catch (error) {
    console.error('Error deleting own key:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * GET /api/validate — Validate the current Bearer token and return its metadata.
 * Any valid key (admin, create, or self-service) can call this.
 */
async function handleValidateKey(request, env) {
  const auth = await verifyApiKey(request, env);
  if (!auth.authorized) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // Bootstrap admin key — no keyId or KV record.
  if (auth.type === 'admin' && !auth.keyId) {
    return jsonResponse({
      valid: true,
      type: 'admin',
      label: 'Bootstrap admin key',
      created: null,
    });
  }

  // Look up the full key record for additional metadata.
  let keyData = null;
  if (auth.keyId) {
    keyData = await env.URL_MAPPINGS.get(`apikey:${auth.keyId}`, { type: 'json' });
  }

  if (!keyData) {
    return jsonResponse({
      valid: true,
      type: auth.type,
      label: auth.type === 'admin' ? 'Admin key' : 'Create key',
      created: null,
    });
  }

  return jsonResponse({
    valid: true,
    type: keyData.type,
    label: keyData.label || '',
    created: keyData.created,
    ...(keyData.owner ? { owner: keyData.owner } : {}),
    ...(keyData.ownerEmail ? { ownerEmail: keyData.ownerEmail } : {}),
    ...(keyData.provider ? { provider: keyData.provider } : {}),
    ...(keyData.createdByCampaign ? { createdByCampaign: keyData.createdByCampaign } : {}),
    tokenPrefix: keyData.tokenPrefix || (keyData.token ? keyData.token.slice(0, 8) + '...' : ''),
  });
}

/**
 * Return JSON response with CORS headers
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

// ---------------------------------------------------------------------------
// Self-service signup: OAuth (Google / GitHub) → create-scoped API key.
//
// Flow: GET /signup → GET /auth/{provider}/login (sets a random state cookie,
// redirects to the provider) → GET /auth/{provider}/callback (verifies state,
// exchanges the code, resolves a verified email) → mintSelfServiceKey.
//
// Each identity holds exactly one key; signing in again revokes the old key
// and mints a fresh one. Tokens are stored hashed:
//   apikey:{id}     → key record (tokenHash + tokenPrefix, no plaintext)
//   tok:{sha256}    → { id }        (O(1) auth lookup)
//   owner:{ident}   → { keyId }     (one-key-per-identity replacement)
//
// Secrets (wrangler secret put): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
// GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET. A provider with no client ID is
// hidden from /signup and its /auth routes return 501.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Self-service signup: email magic link → create-scoped API key.
//
// Flow: POST /signup (email) → send magic link with one-time token (KV, 10min
// TTL) → GET /auth/email/callback?token=... (validate, mint, redirect).
//
// Owners are "email:{sha256(email)}" — one key per verified email address.
// Requires secrets: EMAIL_API_KEY (Resend API key), EMAIL_FROM (sender address).
// ---------------------------------------------------------------------------

const MAGIC_LINK_TOKEN_TTL = 600; // 10 minutes in seconds

/**
 * POST /signup — accept an email address, generate a one-time magic-link
 * token, store it in KV with a TTL, and send the link via email.
 */
async function handleEmailSignup(request, url, env) {
  if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) {
    return htmlResponse(signupShell('<p>Email signup is not enabled on this server.</p>'), 501);
  }

  // Accept both JSON and form-encoded requests.
  let email, campaign;
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    const body = await request.json();
    email = (body.email || '').trim();
    campaign = (body.campaign || '').slice(0, 64);
  } else {
    const form = await request.formData();
    email = (form.get('email') || '').trim();
    campaign = (form.get('campaign') || '').slice(0, 64);
  }

  if (!email || !email.includes('@') || email.length > 254) {
    return htmlResponse(signupShell('<p>Please enter a valid email address. <a href="/signup">Try again</a>.</p>'), 400);
  }

  const token = crypto.randomUUID();
  const redirect = url.searchParams.get('redirect') || '';

  // Store the token in KV with a TTL. Use expiration metadata for auto-cleanup.
  await env.URL_MAPPINGS.put(
    `ml:${token}`,
    JSON.stringify({ email, redirect, campaign, created: new Date().toISOString() }),
    { expirationTtl: MAGIC_LINK_TOKEN_TTL }
  );

  const sent = await sendMagicLink(email, token, redirectOrigin(url), env);
  if (!sent) {
    // Clean up the KV entry so it can't be used later.
    await env.URL_MAPPINGS.delete(`ml:${token}`);
    return htmlResponse(signupShell('<p>Failed to send the email. Please try again later. <a href="/signup">Back</a>.</p>'), 502);
  }

  return htmlResponse(signupShell(
    `<p>A magic link has been sent to <strong>${escapeHtml(email)}</strong>.</p>
     <p>Check your inbox and click the link to receive your API key.
     The link expires in 10 minutes.</p>`
  ));
}

/**
 * GET /auth/email/callback?token=... — validate the magic-link token, mint a
 * create-scoped key, and show the result (or redirect if `redirect` was set).
 */
async function handleEmailCallback(request, url, env) {
  const token = url.searchParams.get('token');

  if (!token) {
    return htmlResponse(signupShell('<p>Missing token. <a href="/signup">Try again</a>.</p>'), 400);
  }

  const record = await env.URL_MAPPINGS.get(`ml:${token}`, { type: 'json' });
  if (!record) {
    return htmlResponse(signupShell('<p>This link has expired or already been used. <a href="/signup">Request a new one</a>.</p>'), 410);
  }

  // Consume the token immediately to prevent reuse.
  await env.URL_MAPPINGS.delete(`ml:${token}`);

  const email = record.email || '';
  const campaign = record.campaign || '';
  // Owner identity is a hash so emails aren't stored in plaintext in the KV key.
  const owner = 'email:' + (await sha256Hex(email));
  const identity = { owner, email, provider: 'email' };

  try {
    const { token: apiToken, replaced } = await mintSelfServiceKey(env, identity, campaign);

    // If the signup was initiated from an app integration, redirect back.
    const returnTo = record.redirect || '';
    if (returnTo && isValidReturnTo(returnTo, url)) {
      const r = new URL(returnTo, url.origin);
      r.searchParams.set('sh_apikey', apiToken);
      r.searchParams.set('sh_email', email);
      if (replaced) r.searchParams.set('sh_replaced', '1');
      return new Response(null, {
        status: 302,
        headers: {
          Location: r.toString(),
          'Cache-Control': 'no-store',
        },
      });
    }

    const body = `
      <p>Signed in as <strong>${escapeHtml(email)}</strong>.</p>
      ${replaced ? '<p>Your previous key has been revoked and replaced.</p>' : ''}
      <p>Your API key — <strong>copy it now; it is shown only once</strong>:</p>
      <pre><code>${escapeHtml(apiToken)}</code></pre>
      <p>Use it as a Bearer token:</p>
      <pre><code>curl -X POST ${escapeHtml(redirectOrigin(url))}/api/shorten \\
  -H "Authorization: Bearer ${escapeHtml(apiToken)}" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com/some/long/path"}'</code></pre>
      <p>Lost it? Just <a href="/signup">sign in again</a> for a new key.</p>`;

    return htmlResponse(signupShell(body));
  } catch (error) {
    console.error('Email callback failed:', error);
    return htmlResponse(signupShell('<p>Sign-in failed. <a href="/signup">Try again</a>.</p>'), 502);
  }
}

/**
 * Send a magic-link email via Resend (resend.com).
 *
 * Requires env.EMAIL_API_KEY (Resend API key) and env.EMAIL_FROM.
 * Returns true on success.
 */
async function sendMagicLink(email, token, origin, env) {
  const link = `${origin}/auth/email/callback?token=${encodeURIComponent(token)}`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.EMAIL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [email],
        subject: 'Your jethro.au API key — magic link',
        text: `Sign in to receive your API key for the jethro.au URL shortener:\n\n${link}\n\nThis link expires in 10 minutes. If you didn't request this, you can ignore this email.`,
        html: `<p>Click the link below to receive your API key for the jethro.au URL shortener:</p>
<p><a href="${link}">${link}</a></p>
<p>This link expires in 10 minutes.</p>
<p>If you didn't request this, you can ignore this email.</p>`,
      }),
    });

    return resp.ok;
  } catch (error) {
    console.error('sendMagicLink error:', error);
    return false;
  }
}

const STATE_COOKIE = 'oauth_state';

const OAUTH_PROVIDERS = {
  google: {
    name: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'openid email',
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    fetchIdentity: fetchGoogleIdentity,
  },
  github: {
    name: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    scope: 'user:email',
    clientId: (env) => env.GITHUB_CLIENT_ID,
    clientSecret: (env) => env.GITHUB_CLIENT_SECRET,
    fetchIdentity: fetchGithubIdentity,
  },
};

/**
 * GET /signup — provider picker page
 */
function handleSignupPage(url, env) {
  const redirect = url.searchParams.get('redirect') || '';
  const campaign = url.searchParams.get('campaign') || '';
  const campaignQS = campaign ? '&campaign=' + encodeURIComponent(campaign) : '';
  const redirectQS = redirect ? '?redirect=' + encodeURIComponent(redirect) + campaignQS : '';

  const oauthButtons = Object.entries(OAUTH_PROVIDERS)
    .filter(([, p]) => p.clientId(env))
    .map(([id, p]) => `<a class="btn" href="/auth/${id}/login${redirectQS}">Sign in with ${p.name}</a>`);

  const emailEnabled = !!(env.EMAIL_API_KEY && env.EMAIL_FROM);

  // If nothing is configured, return 501.
  if (oauthButtons.length === 0 && !emailEnabled) {
    return htmlResponse(signupShell('<p>Self-service signup is not enabled on this server.</p>'), 501);
  }

  let body = `<p>Sign in to receive an API key for creating short URLs.
     You get one key; signing in again replaces it.</p>`;

  // Magic-link email form.
  if (emailEnabled) {
    const campaignInput = campaign
      ? `<input type="hidden" name="campaign" value="${escapeHtml(campaign)}">`
      : '';
    body += `
      <form method="post" action="/signup${redirectQS}">${campaignInput}
        <p>
          <label for="email">Email address:</label><br>
          <input type="email" id="email" name="email" required
                 placeholder="you@example.com"
                 style="padding:0.5em;width:100%;max-width:24em;box-sizing:border-box;">
        </p>
        <p>
          <button type="submit" class="btn" style="cursor:pointer;">
            Send magic link
          </button>
        </p>
      </form>`;
  }

  if (oauthButtons.length > 0) {
    if (emailEnabled) {
      body += '<hr style="margin:1.5em 0"><p>Or sign in with a provider:</p>';
    }
    body += '\n      ' + oauthButtons.join('\n      ');
  }

  return htmlResponse(signupShell(body));
}

/**
 * GET /auth/{provider}/login — set CSRF state cookie, redirect to provider
 */
function handleOAuthLogin(url, env, providerId) {
  const provider = OAUTH_PROVIDERS[providerId];
  if (!provider.clientId(env)) {
    return htmlResponse(signupShell(`<p>${provider.name} sign-in is not configured.</p>`), 501);
  }

  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');

  // Pass post-signup redirect and campaign through the state cookie.
  const returnTo = url.searchParams.get('redirect') || '';
  const returnToValid = isValidReturnTo(returnTo, url) ? returnTo : '';
  const campaign = (url.searchParams.get('campaign') || '').slice(0, 64);

  const cookieValue = JSON.stringify({ state, returnTo: returnToValid, campaign });

  const redirectUri = redirectOrigin(url) + `/auth/${providerId}/callback`;

  const params = new URLSearchParams({
    client_id: provider.clientId(env),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: provider.scope,
    state,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${provider.authorizeUrl}?${params}`,
      'Set-Cookie': `${STATE_COOKIE}=${encodeURIComponent(cookieValue)}; HttpOnly; Secure; Path=/auth; SameSite=Lax; Max-Age=600`,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * GET /auth/{provider}/callback — verify state, exchange code, mint key
 */
async function handleOAuthCallback(request, url, env, providerId) {
  const provider = OAUTH_PROVIDERS[providerId];
  if (!provider.clientId(env)) {
    return htmlResponse(signupShell(`<p>${provider.name} sign-in is not configured.</p>`), 501);
  }

  if (url.searchParams.get('error')) {
    return htmlResponse(signupShell(`<p>Sign-in was cancelled or refused. <a href="/signup">Try again</a>.</p>`), 400);
  }

  const state = url.searchParams.get('state');
  const cookieRaw = getCookie(request, STATE_COOKIE);
  let cookieState, returnTo, campaign;
  try {
    const parsed = cookieRaw ? JSON.parse(decodeURIComponent(cookieRaw)) : null;
    cookieState = parsed?.state;
    returnTo = parsed?.returnTo || '';
    campaign = parsed?.campaign || '';
  } catch {
    // Legacy cookie (plain string, no redirect support)
    cookieState = cookieRaw;
    returnTo = '';
    campaign = '';
  }
  if (!state || !cookieState || state !== cookieState) {
    return htmlResponse(signupShell('<p>Sign-in session expired or invalid. <a href="/signup">Try again</a>.</p>'), 400);
  }

  const code = url.searchParams.get('code');
  if (!code) {
    return htmlResponse(signupShell('<p>Missing authorization code. <a href="/signup">Try again</a>.</p>'), 400);
  }

  try {
    const redirectUri = redirectOrigin(url) + `/auth/${providerId}/callback`;
    const identity = await provider.fetchIdentity(code, redirectUri, env);
    const { token, replaced } = await mintSelfServiceKey(env, identity, campaign);

    // If the signup was initiated from an app integration, redirect back
    // with the token instead of showing the HTML success page.
    // Validate same-origin again as defense-in-depth (the cookie is
    // HttpOnly, but the original redirect param is attacker-controlled).
    const returnToValid = isValidReturnTo(returnTo, url) ? returnTo : '';
    if (returnToValid) {
      const r = new URL(returnToValid, url.origin);
      r.searchParams.set('sh_apikey', token);
      r.searchParams.set('sh_email', identity.email);
      if (replaced) r.searchParams.set('sh_replaced', '1');
      return new Response(null, {
        status: 302,
        headers: {
          Location: r.toString(),
          'Set-Cookie': `${STATE_COOKIE}=; HttpOnly; Secure; Path=/auth; SameSite=Lax; Max-Age=0`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const body = `
      <p>Signed in as <strong>${escapeHtml(identity.email)}</strong>.</p>
      ${replaced ? '<p>Your previous key has been revoked and replaced.</p>' : ''}
      <p>Your API key — <strong>copy it now; it is shown only once</strong>:</p>
      <pre><code>${escapeHtml(token)}</code></pre>
      <p>Use it as a Bearer token:</p>
      <pre><code>curl -X POST ${escapeHtml(redirectOrigin(url))}/api/shorten \\
  -H "Authorization: Bearer ${escapeHtml(token)}" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com/some/long/path"}'</code></pre>
      <p>Lost it? Just <a href="/signup">sign in again</a> for a new key.</p>`;

    return htmlResponse(signupShell(body), 200, {
      // Expire the state cookie
      'Set-Cookie': `${STATE_COOKIE}=; HttpOnly; Secure; Path=/auth; SameSite=Lax; Max-Age=0`,
    });
  } catch (error) {
    console.error(`OAuth ${providerId} callback failed:`, error);
    return htmlResponse(signupShell('<p>Sign-in failed. <a href="/signup">Try again</a>.</p>'), 502);
  }
}

/**
 * Exchange a Google authorization code and return { owner, email, provider }.
 * The id_token comes straight from Google over TLS, so decoding its payload
 * without signature verification is safe here.
 */
async function fetchGoogleIdentity(code, redirectUri, env) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.id_token) {
    throw new Error(`Google token exchange failed: ${data.error || resp.status}`);
  }

  const claims = decodeJwtPayload(data.id_token);
  if (!claims.sub || !claims.email || claims.email_verified !== true) {
    throw new Error('Google identity lacks a verified email');
  }
  return { owner: `google:${claims.sub}`, email: claims.email, provider: 'google' };
}

/**
 * Exchange a GitHub authorization code and return { owner, email, provider }.
 */
async function fetchGithubIdentity(code, redirectUri, env) {
  const resp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
  });
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error(`GitHub token exchange failed: ${data.error || resp.status}`);
  }

  const ghHeaders = {
    Authorization: `Bearer ${data.access_token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'url-shortener-worker', // GitHub API rejects requests without one
  };

  const user = await (await fetch('https://api.github.com/user', { headers: ghHeaders })).json();
  if (!user.id) {
    throw new Error('GitHub user lookup failed');
  }

  const emails = await (await fetch('https://api.github.com/user/emails', { headers: ghHeaders })).json();
  const best = Array.isArray(emails)
    ? emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified)
    : null;
  const email = best ? best.email : null;
  if (!email) {
    throw new Error('GitHub account has no verified email');
  }
  return { owner: `github:${user.id}`, email, provider: 'github' };
}

/**
 * Mint a create-scoped key for an identity, revoking any key it already holds.
 * @param {string} campaign - optional campaign id from the signup flow (max 64 chars)
 * Returns { token, replaced }.
 */
async function mintSelfServiceKey(env, identity, campaign = '') {
  const ownerKey = `owner:${identity.owner}`;
  const prev = await env.URL_MAPPINGS.get(ownerKey, { type: 'json' });
  let replaced = false;

  if (prev && prev.keyId) {
    const prevKey = await env.URL_MAPPINGS.get(`apikey:${prev.keyId}`, { type: 'json' });
    await env.URL_MAPPINGS.delete(`apikey:${prev.keyId}`);
    if (prevKey && prevKey.tokenHash) {
      await env.URL_MAPPINGS.delete(`tok:${prevKey.tokenHash}`);
    }
    replaced = true;
  }

  const id = crypto.randomUUID();
  const token = 'cus_' + crypto.randomUUID().replace(/-/g, '');
  const tokenHash = await sha256Hex(token);
  const keyData = {
    id,
    type: 'create',
    label: identity.email,
    owner: identity.owner,
    ownerEmail: identity.email,
    provider: identity.provider,
    tokenPrefix: token.slice(0, 8) + '...',
    tokenHash,
    created: new Date().toISOString(),
  };

  if (campaign) {
    keyData.createdByCampaign = campaign;
  }

  await env.URL_MAPPINGS.put(`apikey:${id}`, JSON.stringify(keyData));
  await env.URL_MAPPINGS.put(`tok:${tokenHash}`, JSON.stringify({ id }));
  await env.URL_MAPPINGS.put(ownerKey, JSON.stringify({ keyId: id }));

  return { token, replaced };
}

/**
 * Decode a JWT payload (no signature verification — only for tokens received
 * directly from the issuer over TLS).
 */
function decodeJwtPayload(jwt) {
  const part = jwt.split('.')[1];
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Validate a post-signup return URL: must be an absolute http(s) URL.  We do
 * NOT enforce same-origin because the redirect target is the integrating app,
 * which runs on a different domain than the shortener.
 *
 * ACCEPTED RISK — the API key is passed as a query parameter (sh_apikey) on
 * the redirect.  An attacker who convinces a victim to click a crafted
 * /signup?redirect=https://evil.com link could receive the key.  Mitigations:
 *   • The key is also shown on an HTML success page — the redirect is a
 *     convenience, not the only path to the key.
 *   • The victim must actively complete sign-in (OAuth or magic link).
 *   • Each identity holds exactly one key; re-signing rotates it.
 */
function isValidReturnTo(returnTo, _requestUrl) {
  if (!returnTo) return false;
  // Only absolute http(s) — reject javascript:, data:, etc.
  if (!/^https?:\/\//.test(returnTo)) return false;
  try {
    new URL(returnTo);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the origin for OAuth redirect URIs, forcing HTTPS except for localhost.
 * Cloudflare terminates TLS at the edge, so url.origin may be http:// internally.
 */
function redirectOrigin(url) {
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return url.origin;
  }
  return `https://${url.host}`;
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || '';
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function signupShell(body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>URL Shortener — API key signup</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
    .btn { display: inline-block; margin: 0.5rem 0.5rem 0.5rem 0; padding: 0.6rem 1.2rem; border: 1px solid #888;
           border-radius: 6px; text-decoration: none; color: inherit; }
    pre { background: #f4f4f4; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } pre { background: #222; } }
  </style>
</head>
<body>
  <h1>Get an API key</h1>
  ${body}
</body>
</html>`;
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders,
    },
  });
}
