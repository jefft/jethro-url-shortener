<?php
/**
 * URL Shortener library — create short URLs via jethro.au API.
 *
 * Requires URLSHORTENER_API_KEY environment variable (set by devbox.json env).
 * Uses a create-only key — safe to commit; cannot list/delete/update URLs.
 */

/**
 * Shorten a URL.
 *
 * @param string $url      The long URL to shorten.
 * @param string $campaign Optional UTM campaign tag (default "general").
 * @return array{shortUrl: string, code: string, longUrl: string} On success.
 * @throws RuntimeException On API or network error.
 */
function shorten_url(string $url, string $campaign = 'general'): array {
    $apiKey = getenv('URLSHORTENER_API_KEY');
    if (!$apiKey) {
        throw new RuntimeException('URLSHORTENER_API_KEY environment variable not set');
    }

    $ch = curl_init('https://jethro.au/api/shorten');

    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => [
            "Authorization: Bearer $apiKey",
            'Content-Type: application/json',
        ],
        CURLOPT_POSTFIELDS     => json_encode([
            'url'      => $url,
            'campaign' => $campaign,
        ]),
        CURLOPT_TIMEOUT        => 10,
    ]);

    $body = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    if ($error) {
        throw new RuntimeException("Network error: $error");
    }

    $data = json_decode($body, true);
    if ($httpCode !== 200 || !is_array($data) || !isset($data['shortUrl'])) {
        $msg = $data['error'] ?? "HTTP $httpCode";
        throw new RuntimeException("API error: $msg");
    }

    return $data;
}
