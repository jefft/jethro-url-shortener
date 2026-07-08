# PHP Integration — jethro.au URL Shortener self-service signup

This document describes how to integrate the self-service OAuth signup flow into a PHP application, so users can obtain an API key without an admin manually creating one.

## How it works

```
Admin page                    jethro.au Worker              Google / GitHub
    │                              │                              │
    │  "Register" link ──────────► │                              │
    │  /signup?redirect=...        │                              │
    │                              │── redirect to provider ─────►│
    │                              │                              │
    │                              │◄──── auth code ──────────────│
    │                              │                              │
    │◄── redirect with key ───────│                              │
    │  ?sh_apikey=cus_...         │                              │
    │  &sh_email=name@domain      │                              │
    │                              │                              │
    ▼                              │                              │
  Save key to config              │                              │
  Show success                    │                              │
```

1. Your app displays a "Register for jethro.au shortener" link that points to `https://jethro.au/signup?redirect=https://yourdomain/admin/callback-page`
2. The user signs in with Google or GitHub
3. The worker mints a `create`-scoped key and redirects back to your URL with the key in query parameters
4. Your app saves the key and reloads

## Step 1 — Add the signup link

In your admin settings page or SMS configuration view, add a check: if `URLSHORTENER_API_KEY` is not defined, show the registration link.

```php
<?php
use JethroAuUrlShortener;

require_once 'src/UrlShortener.php';

// Build the URL that the signup flow should redirect back to.
// This must be an absolute URL on the same origin as the signup request.
// The worker rejects cross-origin redirect targets to prevent API key exfiltration.
$callbackUrl = 'https://' . $_SERVER['HTTP_HOST']
    . parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH)
    . '?' . $_SERVER['QUERY_STRING'];

$signupUrl = (new JethroAuUrlShortener(apiKey: ''))->getSignupUrl($callbackUrl);
?>
<a href="<?= htmlspecialchars($signupUrl) ?>">Register to enable https://jethro.au shortener</a>
```

The worker validates that the `redirect` target has the **same hostname** as the signup request, preventing open-redirect attacks. Localhost origins are also permitted.

## Step 2 — Handle the callback

After sign-in, the worker redirects back to your page with these query parameters:

| Parameter      | Description                                    |
|----------------|------------------------------------------------|
| `sh_apikey`    | The API key (starts with `cus_`)               |
| `sh_email`     | The email address of the signed-in user        |
| `sh_replaced`  | Present (value `1`) if an existing key was replaced |

At the top of your admin page (before any output), check for the callback:

```php
<?php
use JethroAuUrlShortener;

require_once 'src/UrlShortener.php';

if (JethroAuUrlShortener::isSignupCallback()) {
    $payload = JethroAuUrlShortener::getTokenFromCallback();
    if ($payload !== null) {
        // Save the key to conf.php (see Step 3)
        saveApiKey($payload['token']);

        $msg = 'API key registered for ' . htmlspecialchars($payload['email']);
        if ($payload['replaced']) {
            $msg .= ' (previous key replaced).';
        }
        // Redirect to self to clear the query params from the URL
        header('Location: ' . strtok($_SERVER['REQUEST_URI'], '?'));
        echo '<p>' . $msg . ' — <a href="' . htmlspecialchars($_SERVER['REQUEST_URI']) . '">Continue</a></p>';
        exit;
    }
}
?>
```

**Important:** After saving the key, redirect to yourself without the query parameters. Otherwise the key remains visible in the browser's address bar and history.

## Step 3 — Save the API key

The token should be written to `conf.php` as the `URLSHORTENER_API_KEY` constant. A helper for appending to the config file:

```php
<?php
/**
 * Append (or update) a define() line in conf.php.
 */
function saveApiKey(string $token): void
{
    $confFile = __DIR__ . '/conf.php';
    $content = file_get_contents($confFile);
    $newLine = "define('URLSHORTENER_API_KEY', '" . addslashes($token) . "');\n";

    if (preg_match("/^define\\(['\"]URLSHORTENER_API_KEY['\"]/m", $content)) {
        // Replace existing
        $content = preg_replace(
            "/^define\\(['\"]URLSHORTENER_API_KEY['\"],\\s*'.*'\\);$/m",
            $newLine,
            $content
        );
    } else {
        // Append after the URLSHORTENER line
        $content = preg_replace(
            "/(define\\(['\"]URLSHORTENER['\"],\\s*'[^']*'\\);)/",
            "$1\n" . $newLine,
            $content
        );
    }

    file_put_contents($confFile, $content);
}
```

**Security note:** The API key is write-only — it cannot be retrieved from the worker after this. If the key is lost, the user signs in again (which revokes the old key and issues a new one).

## Step 4 — Verify the integration

```bash
# Test the shortener is now wired up
curl -X POST https://jethro.au/api/shorten \
  -H "Authorization: Bearer <key-from-conf.php>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/test", "campaign": "integration-test"}'

# Should return 200 with a shortUrl
```

## Reference

### JethroAuUrlShortener signup methods

| Method | Description |
|--------|-------------|
| `getSignupUrl(string $redirectAfter): string` | Build the signup URL. `$redirectAfter` is the absolute URL the worker will redirect back to with the key. Must be same-origin as the signup request. |
| `isSignupCallback(): bool` | Returns `true` if the current request contains a signup callback (`sh_apikey` in GET params). |
| `getTokenFromCallback(): ?array` | Extracts `{token, email, replaced}` from the callback, or `null` if invalid/absent. |

### Callback query parameters

The worker appends these to your `redirect` URL:

- `sh_apikey` — the API key (starts with `cus_`)
- `sh_email` — the verified email of the identity
- `sh_replaced=1` — set when the identity already had a key (old key was revoked)

### Key characteristics

- **Scope:** `create` only — can shorten URLs, cannot list/update/delete or manage keys
- **One per identity:** Signing in again revokes the old key and issues a new one
- **Attribution:** URLs created with this key carry a `createdBy` field (e.g. `google:123456789`)

### Troubleshooting

| Problem | Likely cause |
|---------|-------------|
| `/signup` returns 501 | OAuth provider secrets not set (`wrangler secret put GOOGLE_CLIENT_ID` etc.) |
| Google shows `redirect_uri_mismatch` | The redirect URI registered in Google Console must be `https://yourdomain/auth/google/callback` |
| Callback redirect doesn't fire | The `redirect` param value must be same-origin; check for typos, missing `https://`, or trailing whitespace |
| Key doesn't work after callback | The worker must be deployed with the latest code (supporting `?redirect=`); deploy first |
