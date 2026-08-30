<?php
// Root front-controller: serve SPA shell for all non-file, non-api, non-raw requests
if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' || (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') || (!empty($_SERVER['SERVER_PORT']) && (int)$_SERVER['SERVER_PORT'] === 443)) {
    header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
}
header('X-Frame-Options: SAMEORIGIN');
header('Referrer-Policy: strict-origin-when-cross-origin');
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if (preg_match('#^/(data|\.git|\.env)(\/|$)#', $uri)) { http_response_code(404); exit; }
$ext = pathinfo($uri, PATHINFO_EXTENSION);

// let real files through (public/*, api/* handled by api/index.php via rewrite)
if ($ext && $ext !== 'php') {
    return false; // let nginx/apache try_files handle it; for php -S we 404
}

// For php built-in server, serve static files directly
if (php_sapi_name() === 'cli-server') {
    $file = __DIR__ . $uri;
    if ($uri !== '/' && file_exists($file) && is_file($file)) return false;
}

// SPA shell — same as public/index.html but at /
readfile(__DIR__ . '/public/index.html');
