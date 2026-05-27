<?php
// Minimal smoke test for PHP on AccuWeb.
// Upload this file via cPanel File Manager (or SFTP) to your webroot at
//   public_html/api/health.php
// then hit:
//   https://pailthorp.net/api/health.php
//
// If PHP is enabled you'll get a JSON body with the server's PHP version
// and request URI. If PHP is NOT being executed, the browser will instead
// show you this file's source — that's the signal to enable PHP for the
// account (or check that .php extensions aren't being served as text).
//
// Safe to deploy — leaks only PHP version + the current URL. Delete (or
// leave behind) once verified; the hybrid-search proxy lands at
// /api/airport-lookup.php in a follow-up.

header("Content-Type: application/json; charset=utf-8");
header("Cache-Control: no-store");

echo json_encode([
    "ok"          => true,
    "php_version" => PHP_VERSION,
    "sapi"        => PHP_SAPI,
    "request_uri" => $_SERVER["REQUEST_URI"] ?? null,
    "host"        => $_SERVER["HTTP_HOST"] ?? null,
    "server_time" => gmdate("c"),
], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
