#!/usr/bin/env php
<?php
require_once __DIR__ . '/src/UrlShortener.php';

$opts = getopt('', ['apitoken:', 'campaign:']);

$apiToken = $opts['apitoken'] ?? getenv('URLSHORTENER_API_KEY') ?: '';
$campaign = $opts['campaign'] ?? null; // null = use default (API key prefix)

define('URLSHORTENER', getenv('URLSHORTENER') ?: 'jethroau');
define('URLSHORTENER_API_KEY', $apiToken);

if ($apiToken === '') {
    fwrite(STDERR, "Error: no API key. Set URLSHORTENER_API_KEY env var or pass --apitoken.\n");
    exit(1);
}

const TEST_URL = 'https://example.com/functional-test-target';
$passed = 0; $failed = 0;
function pass($m) { global $passed; echo "  \u{2713} $m\n"; $passed++; }
function fail($m) { global $failed; echo "  \u{2717} $m\n"; $failed++; }

$s = getUrlShortener();

$campaignLabel = $campaign ?? 'default (API key prefix)';
echo "Using campaign: $campaignLabel\n\n";

echo "Test 1: previewShorten() matches real API\n";
try {
    $previewUrl = $campaign !== null
        ? $s->previewShorten(TEST_URL, $campaign)
        : $s->previewShorten(TEST_URL);
    $previewCode = substr(strrchr($previewUrl, '/'), 1);
    $realUrl = $campaign !== null
        ? $s->shorten(TEST_URL, $campaign)
        : $s->shorten(TEST_URL);
    $realCode = substr(strrchr($realUrl, '/'), 1);
    if ($realCode === $previewCode) pass("predicted code '$previewCode' matches API '$realCode'");
    else fail("predicted '$previewCode' but API returned '$realCode'");
    if ($realUrl === $previewUrl) pass("shortUrl matches expected");
    else fail("shortUrl mismatch");
    $shortUrl = $realUrl;
} catch (\RuntimeException $e) { fail("API error: {$e->getMessage()}"); echo "\nAborting.\n"; exit(1); }

echo "\nTest 2: short URL redirects to original target\n";
try {
    $r = $s->fetchRedirect($shortUrl);
    if ($r['status'] === 302) pass("HTTP 302 redirect");
    else fail("expected 302, got {$r['status']}");
    $stripped = strtok($r['location'] ?? '', '?');
    if ($stripped === TEST_URL) pass("redirect location matches original");
    else fail("location mismatch: '$stripped'");
} catch (\RuntimeException $e) { fail("redirect error: {$e->getMessage()}"); }

echo "\n" . str_repeat("\u{2500}", 40) . "\nPassed: $passed  Failed: $failed\n";
exit($failed > 0 ? 1 : 0);
