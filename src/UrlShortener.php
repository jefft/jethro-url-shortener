<?php
/**
 * URL Shortener abstraction.
 */

interface UrlShortener
{
    /** @param string|null $campaign defaults to the first 8 chars of the API key */
    public function shorten(string $url, ?string $campaign = null): string;
    /** @param string|null $campaign defaults to the first 8 chars of the API key */
    public function previewShorten(string $url, ?string $campaign = null): string;
    public function fetchRedirect(string $shortUrl): array;
}

class JethroAuUrlShortener implements UrlShortener
{
    public function __construct(
        private string $apiKey,
        private string $endpoint = 'https://jethro.au/api/shorten',
        private string $signupBase = 'https://jethro.au',
    ) {}

    /**
     * Build the URL that starts the self-service OAuth signup flow.
     *
     * After sign-in, the worker redirects back to $redirectAfter with:
     *   ?sh_apikey=<token>&sh_email=<email>[&sh_replaced=1]
     *
     * @param string $redirectAfter Absolute URL on your site to receive the API key
     * @param string $campaign      Optional campaign id to stamp on the key (max 64 chars)
     */
    public function getSignupUrl(string $redirectAfter, string $campaign = ''): string
    {
        $url = $this->signupBase . '/signup?redirect=' . urlencode($redirectAfter);
        if ($campaign !== '') {
            $url .= '&campaign=' . urlencode($campaign);
        }
        return $url;
    }

    /**
     * Check whether the current request is a signup callback returning a key.
     */
    public static function isSignupCallback(): bool
    {
        return isset($_GET['sh_apikey']);
    }

    /**
     * Extract the API-key payload from a signup callback, or null if absent/invalid.
     *
     * @return array{token: string, email: string, replaced: bool}|null
     */
    public static function getTokenFromCallback(): ?array
    {
        if (!self::isSignupCallback()) {
            return null;
        }
        $token = $_GET['sh_apikey'] ?? '';
        $email = $_GET['sh_email'] ?? '';
        if ($token === '' || !str_starts_with($token, 'cus_')) {
            return null;
        }
        return [
            'token' => $token,
            'email' => $email !== '' ? $email : 'unknown',
            'replaced' => !empty($_GET['sh_replaced']),
        ];
    }

    public function shorten(string $url, ?string $campaign = null): string
    {
        $campaign ??= substr($this->apiKey, 0, 8);
        static $cache = [];
        $key = $url . '|' . $campaign;
        if (isset($cache[$key])) return $cache[$key];

        $ch = curl_init($this->endpoint);
        curl_setopt_array($ch, [
            CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => ["Authorization: Bearer {$this->apiKey}", 'Content-Type: application/json'],
            CURLOPT_POSTFIELDS => json_encode(['url' => $url, 'campaign' => $campaign]),
            CURLOPT_TIMEOUT => 5,
        ]);
        $body = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);
        if ($error) throw new \RuntimeException("URL shortener: network error ($error)");

        $data = json_decode($body, true);
        if ($httpCode !== 200 || !is_array($data) || !isset($data['shortUrl']))
            throw new \RuntimeException("URL shortener: API error (" . ($data['error'] ?? "HTTP $httpCode") . ")");

        $shortUrl = $data['shortUrl'];
        if (!is_string($shortUrl) || $shortUrl === '' || !str_starts_with($shortUrl, 'https://') || preg_match('/[<>"\']/', $shortUrl))
            throw new \RuntimeException("URL shortener: invalid shortUrl returned");

        return $cache[$key] = $shortUrl;
    }

    public function previewShorten(string $url, ?string $campaign = null): string
    {
        $campaign ??= substr($this->apiKey, 0, 8);
        $code = substr(hash('sha256', $url . '::' . $campaign), 0, 6);
        return 'https://jethro.au/s/' . $code;
    }

    public function fetchRedirect(string $shortUrl): array
    {
        $ch = curl_init($shortUrl);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => 10]);
        curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $location = curl_getinfo($ch, CURLINFO_REDIRECT_URL);
        $error = curl_error($ch);
        curl_close($ch);
        if ($error) throw new \RuntimeException("URL shortener: network error ($error)");
        return ['status' => $status, 'location' => $location];
    }
}

function getUrlShortener(): UrlShortener
{
    static $shortener = null;
    if ($shortener !== null) return $shortener;
    $key = defined('URLSHORTENER') ? (string) URLSHORTENER : '';
    if ($key === '') throw new \RuntimeException('URLSHORTENER not configured');
    $shortener = match ($key) {
        'jethroau' => new JethroAuUrlShortener(apiKey: defined('URLSHORTENER_API_KEY') ? (string) URLSHORTENER_API_KEY : ''),
        default => throw new \RuntimeException("Unknown URL shortener: $key"),
    };
    return $shortener;
}
