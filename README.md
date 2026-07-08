# jethro.au URL Shortener

A heavily modified fork of [IAMDevBox/cloudflare-url-shortener](https://github.com/IAMDevBox/cloudflare-url-shortener) deployed at [jethro.au](https://jethro.au), used for shortening URLs in Jethro SMSes.

A production-ready, self-hosted URL shortener built with **Cloudflare Workers** and **KV storage**. Zero cost, global edge performance, and full CRUD admin API with click analytics.

> 📖 **Upstream tutorial**: [Building a Self-Hosted URL Shortener with Cloudflare Workers](https://www.iamdevbox.com/posts/building-self-hosted-url-shortener-cloudflare-workers/)

## Features

- **Short URL redirects** — `/s/{code}` → full URL, served from edge cache with stale-while-revalidate
- **Deterministic short codes** — SHA-256 hash of `(url, campaign)` makes creation idempotent: same inputs always produce the same code
- **Click analytics** — per-code click counters in dedicated KV keys (reads never touch the URL mapping)
- **Full CRUD API** — create, list, update, soft-delete, restore, permanent-delete
- **Multi-key authentication** — admin and create-only API keys with full CRUD management, revocable without rotating the bootstrap key
- **Self-service signup** — anyone can obtain a create-only key via Google, GitHub, or email magic link at `/signup`
- **Campaign attribution** — keys created via the signup flow are stamped with a campaign id, and every URL shortened with that key inherits it — so you can trace which organisation created which link
- **Privacy-preserving deregistration** — self-service key revocation (`DELETE /api/keys/mine`) scrubs owner identity and campaign from all URLs created by that key, while the shortened URLs themselves keep working
- **Campaign tagging** — organize URLs by campaign
- **Notes field** — admin annotations per URL (up to 500 chars)
- **Soft delete + restore** — data is preserved until you permanently remove it
- **Edge caching** — Workers Cache with cache tags and automatic invalidation on mutations
- **PHP library** — typed PHP client with preview capability for offline code prediction
- **CORS support** — works with any frontend admin dashboard
- **Zero cost** — fits within Cloudflare's free tier (100k requests/day)

## Changes from upstream

### Non-enumerable, deterministic short codes

Shortened URLs are of the form https://jethro.au/s/{code}.

Upstream's short URL codes are a simple integer counter.

Our codes are derived from a SHA-256 hash of `(url, campaign)`, making creation **idempotent** — posting the same URL + campaign always returns the same short code. The campaign acts as a salt: same URL with different campaigns produces different codes. By default the campaign is the first 8 characters of the API key, so each installation produces different codes for the same URL — unguessable across tenants. You can override the campaign to a semantic tag (e.g. `"sms"`, `"email"`) for filtering in listings. Short codes are 6-character alphanumeric, collision-resistant.

Being deterministic allows the client to determine what the code will be, ahead of time. This allows the SMS preview to show a shortened URL calculated locally, and only actually hit the https://jethro.au shortener API when a SMS is actually sent. This makes previewing fast and cheap, which is necessary because it happens on each keypress (debounced).

### No UTM parameter injection

Upstream injects `utm_source`, `utm_medium`, `utm_campaign`, and `utm_content` query parameters on every redirect. This fork has removed all UTM tracking — redirects are clean, preserving only the original target URL.

### Separate click stats

Upstream stores click statistics in `stats:{code}` KV keys with per-source breakdowns (twitter, linkedin, direct, etc.). This fork stores a simple `{ total }` counter in a dedicated `stats:{code}` key, separate from the URL mapping. Keeping clicks out of the mapping document prevents read-modify-write races where a concurrent admin mutation (delete, update) could be reverted by a stats write holding a stale copy of the mapping.

### Multi-key authentication

Two key types stored in KV with full CRUD management:

| Type | Scope |
|------|-------|
| `admin` | Full access — create, list, update, delete URLs; manage API keys |
| `create` | Create-only — can shorten URLs, cannot list/update/delete |

Keys are revocable without rotating the bootstrap admin key. The bootstrap key is set via `wrangler secret put API_KEY` and stored as a Cloudflare Workers secret.

### Self-service API keys (OAuth + email signup)

Anyone can obtain a `create`-scoped key by signing in at `/signup`:

1. User visits `https://yourdomain.com/signup` and picks a provider (Google, GitHub, or email magic link).
2. After sign-in, the worker verifies the identity (verified email required) and mints a key, shown once.
3. Each identity holds exactly one key — signing in again revokes the old key and issues a new one (self-service rotation).

All API keys (bootstrap, admin-created, and self-service) are stored hashed: `tok:{sha256}` → `apikey:{id}` lookup, no plaintext tokens in KV. Self-service keys are also stamped with their owner (`google:{sub}` / `github:{id}` / `email:{hash}` plus email) and an optional campaign id passed as `?campaign=` on the signup URL. URLs created with such a key carry `createdBy` and `createdByCampaign` fields, so every short link is attributable to a person and their organisation. Admins see owners via `GET /api/keys` and can revoke with `DELETE /api/keys/{id}`.

Key holders can deregister themselves via `DELETE /api/keys/mine`, which revokes the key and scrubs their `createdBy` / `createdByCampaign` attribution from any URLs they created. The shortened URLs themselves are untouched — they continue to work, just anonymously.

Setup is optional — see [step 6 of the Quick Start](#6-optional-enable-self-service-api-key-signup). Providers with no client ID configured are hidden from `/signup`; with neither configured the page returns 501 and the feature is effectively off.

### Devbox tooling

[Devbox](https://www.jetify.com/devbox) manages Node.js and PHP runtimes. Commands:

```bash
devbox run test                 # Run functional tests
devbox run deploy               # Redeploy the worker
devbox run shorten <url> [c]    # Create a short URL
devbox run stats <code>         # Get click stats
devbox run list-urls            # List all active URLs
devbox run list-keys            # List API keys
devbox run create-key <label> [--type <type>]   # Create an API key
devbox run revoke-key <id>      # Revoke an API key
devbox run redirect <code>      # Show redirect target
devbox run help                 # Show all commands
```

Environment configured via `.env` (gitignored) and `devbox.json` `env` field, which reads from `.env` via `"env_from": ".env"`.

### PHP library

Jethro is PHP, so we provide a PHP library for interacting with the shortener.

`src/UrlShortener.php` — interface + factory for use in any PHP project:

```php
require_once 'src/UrlShortener.php';

define('URLSHORTENER', 'jethroau');
define('URLSHORTENER_API_KEY', 'cus_...');

$s = getUrlShortener();
// Short codes are salted with the API key prefix, so each installation
// produces different codes for the same URL — unguessable across tenants.
$s->shorten('https://example.com/long');                  // → https://jethro.au/s/abc123
$s->previewShorten('https://example.com/long');            // predicted, no API call — same code
$s->fetchRedirect('https://jethro.au/s/abc123');           // → ['status' => 302, 'location' => ...]

// You can override the campaign for semantic tagging (e.g. "sms", "email"):
$s->shorten('https://example.com/long', campaign: 'email');

// Build a signup URL that stamps the key with a campaign id:
$signupUrl = $s->getSignupUrl('https://my.app/callback', 'my-organisation');
// → https://jethro.au/signup?redirect=...&campaign=my-organisation
```

`shorten.php` — CLI frontend using the library:

```bash
devbox run -- php shorten.php https://example.com/my-post twitter
# → https://jethro.au/s/abc123
```

### Tests

```bash
devbox run test
```

Functional test verifies the full pipeline: predicts a short code via `previewShorten()`, creates it via the live API, confirms the codes match, fetches the short URL, and validates the 302 redirect to the original target.

## Architecture

```
User → /s/{code} → Cloudflare Worker (edge, <15ms) → KV lookup → 302 redirect
                                                     ↓
                                               Stats increment (async)
                                               ↓
                                          Edge cache (1h fresh, 24h stale)
```

## Quick Start

### 1. Clone and install

```bash
git clone git@github.com:jefft/jethro-url-shortener.git
cd jethro-url-shortener
devbox shell         # provisions Node.js 24 + PHP 8.4
npm install
```

### 2. Create a KV namespace

```
npx wrangler kv:namespace create URL_MAPPINGS
```

### 3. Configure `wrangler.toml`

```bash
cp wrangler.toml.example wrangler.toml
```

Replace the placeholders:

```toml
[[kv_namespaces]]
binding = "URL_MAPPINGS"
id = "YOUR_KV_NAMESPACE_ID"   # from step 2

[[routes]]
pattern = "yourdomain.com/s/*"
zone_name = "yourdomain.com"
```

### 4. Set your admin API key

```bash
cp .env.example .env
# Add URLSHORTENER_ADMIN_KEY=your-secret-value
npx wrangler secret put API_KEY
# Enter the same secret when prompted
```

This is your **bootstrap admin key** — it has full access and cannot be revoked via the API. Use it to create additional keys (including scoped create-only keys) via `/api/keys`.

### 5. Deploy

```bash
npx wrangler deploy
```

That's it — your URL shortener is live at `https://yourdomain.com/s/*`.

### 6. (Optional) Enable self-service API key signup

Lets anyone mint their own `create`-scoped key by signing in at `https://yourdomain.com/signup`. Skip this step and the feature stays off. You can enable any or all of the three providers: Google OAuth, GitHub OAuth, and email magic link.

**Google** (in [Google Cloud Console](https://console.cloud.google.com/)):

1. Create (or select) a project — any name, e.g. `url-shortener`.
2. Under **APIs & Services → OAuth consent screen**, set the app name and support email, and choose **External** as the audience. Publish the app (while it's in "Testing" mode, only listed test users can sign in). The flow only requests the non-sensitive `openid email` scopes, so no Google review is required.
3. Under  [Google Auth Platform → Clients → Create client](https://console.cloud.google.com/auth/clients/create) click **Create Credentials → OAuth client ID**, application type **Web application**.
4. Add the authorized redirect URI: `https://yourdomain.com/auth/google/callback`
5. Copy the **Client ID** and **Client secret**.

**GitHub** (in [Developer settings → OAuth Apps](https://github.com/settings/developers)):

1. Click **New OAuth App**.
2. Set an application name, homepage URL `https://yourdomain.com`, and authorization callback URL: `https://yourdomain.com/auth/github/callback`
3. Register, then click **Generate a new client secret**. Copy the **Client ID** and the secret.

**Email magic link** (uses [Resend](https://resend.com) to deliver the link):

1. Create a free [Resend](https://resend.com) account and get an API key.
2. Verify your sending domain, or use Resend's testing domain for development.

**Store the credentials as Worker secrets** and redeploy:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put EMAIL_API_KEY     # Resend API key
npx wrangler secret put EMAIL_FROM        # e.g. "shortener@yourdomain.com"
npx wrangler deploy
```

Visit `https://yourdomain.com/signup` to test: sign in, and your API key is shown once. Each identity holds one key; signing in again revokes the old key and issues a new one. Keys and their owners are visible to admins via `GET /api/keys`.

## API Reference

All write endpoints require `Authorization: Bearer YOUR_API_KEY` (admin or create, depending on the endpoint).

### Create a short URL

```bash
curl -X POST https://yourdomain.com/api/shorten \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/very/long/blog/post/",
    "code": "oauth",          # optional custom code (auto-generated if omitted)
    "campaign": "blog_post",  # optional campaign tag (default: "general")
    "notes": "OAuth guide"    # optional admin note (max 500 chars)
  }'
```

Response:
```json
{
  "shortUrl": "https://yourdomain.com/s/oauth",
  "code": "oauth",
  "longUrl": "https://example.com/very/long/blog/post/"
}
```

If the same URL + campaign was already created, the response includes `"existing": true` and returns the existing short code (idempotent).

### Get click statistics

```bash
curl https://yourdomain.com/api/stats/oauth
```

Response:
```json
{
  "total": 142
}
```

### List all active URLs

```bash
curl https://yourdomain.com/api/urls \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Requires admin key.

### List deleted URLs

```bash
curl https://yourdomain.com/api/urls/deleted \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Requires admin key.

### Update a URL

```bash
curl -X PUT https://yourdomain.com/api/urls/oauth \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/new-url/", "campaign": "updated", "notes": "Updated destination"}'
```

You can update the target URL, campaign, short code (rename), and notes. Requires admin key.

### Soft delete (recoverable)

```bash
curl -X DELETE https://yourdomain.com/api/urls/oauth \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Requires admin key.

### Restore a deleted URL

```bash
curl -X POST https://yourdomain.com/api/urls/oauth/restore \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Requires admin key.

### Permanent delete (irreversible)

```bash
# Must soft-delete first, then permanently remove
curl -X DELETE https://yourdomain.com/api/urls/oauth/permanent \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Requires admin key.

### List API keys

```bash
curl https://yourdomain.com/api/keys \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Requires admin key.

### Create an API key

```bash
curl -X POST https://yourdomain.com/api/keys \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "create", "label": "CI/CD pipeline"}'
```

Response:
```json
{
  "id": "uuid",
  "token": "cus_...",
  "type": "create",
  "label": "CI/CD pipeline",
  "created": "2025-07-01T10:30:00Z"
}
```

The `token` is only returned once on creation. `type` must be `"admin"` or `"create"`. Requires admin key.

### Revoke an API key

```bash
curl -X DELETE https://yourdomain.com/api/keys/{id} \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Requires admin key. The bootstrap admin key (set via `wrangler secret`) cannot be revoked via the API.

### Revoke your own key (self-service deregistration)

```bash
curl -X DELETE https://yourdomain.com/api/keys/mine \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Any valid key can revoke itself. This deletes the key from KV and scrubs the owner's identity and campaign from any URLs they created — the shortened URLs themselves continue to work.

## Caching

This worker uses [Cloudflare Workers Cache](https://blog.cloudflare.com/workers-cache/) to serve redirects and stats from edge cache, reducing latency and KV read costs.

### Cached Endpoints

| Endpoint | Cache Duration | Stale-while-revalidate |
|---|---|---|
| `GET /s/{code}` (redirect) | 1 hour (`max-age=3600`) | 24 hours |
| `GET /api/stats/{code}` | 1 minute (`max-age=60`) | 5 minutes |

### How It Works

- **Fresh window** (within `max-age`): The response is served directly from Cloudflare's edge cache. The Worker does NOT run, so click stats are NOT incremented during this window.
- **Stale window** (`max-age` to `max-age + stale-while-revalidate`): The cached response is served immediately while the Worker runs in the background. Click stats ARE incremented during revalidation.
- **After both windows**: A full cache miss occurs, and the Worker fetches from KV.

### Cache Invalidation

Cache entries are automatically purged when a URL is mutated:

- **Update** (`PUT /api/urls/{code}`) — purges redirect and stats cache for the affected code(s)
- **Delete** (`DELETE /api/urls/{code}`) — purges cache so deleted URLs return 404 immediately
- **Restore** (`POST /api/urls/{code}/restore`) — purges cache so restored URLs are accessible
- **Permanent delete** (`DELETE /api/urls/{code}/permanent`) — purges cache

Cache tags used: `redirect:{code}` and `stats:{code}`.

Purges are eventually consistent — expect a few seconds of propagation delay across the edge before a purged code reliably returns a fresh (`MISS`) response.

### Configuration

Cache is enabled in `wrangler.toml` with `cache = { enabled = true }`. The `compatibility_date` must be `2026-05-01` or later.

### Local Development

Workers Cache is a Cloudflare edge product and is **not** available in `wrangler dev --local`. The code guards against `ctx.cache` being undefined, so all endpoints continue to work normally without caching during local development.

## Cost Analysis

Cloudflare Workers **free tier** per day:
- 100,000 Worker requests
- 1GB KV storage
- 100,000 KV reads + 1,000 KV writes

A typical blog gets ~500 short URL clicks/day — well within free tier.

| Service | Monthly cost |
|---------|-------------|
| Bitly Pro | $29 |
| TinyURL Pro | $9.99 |
| **This solution** | **$0** |

## License

MIT — use freely in your own projects.
