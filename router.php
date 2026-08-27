<?php
// router for php -S; apache/nginx use .htaccess
if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' || (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') || (!empty($_SERVER['SERVER_PORT']) && (int)$_SERVER['SERVER_PORT'] === 443)) {
    header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
}
header('X-Frame-Options: SAMEORIGIN');
header('Referrer-Policy: strict-origin-when-cross-origin');
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
// block sensitive paths even on dev server (mirrors nginx deny)
if (preg_match('#^/(data|\.git|\.env)(\/|$)#', $uri)) { http_response_code(404); exit; }
if (preg_match('#^/(api|raw|i)(/|$)#', $uri)) {
    require __DIR__ . '/api/index.php';
    exit;
}
// serve public assets: /css/* -> public/css/* and /js/* -> public/js/*
if (preg_match('#^/(css|js)(/|$)#', $uri)) {
    $f = __DIR__ . '/public' . $uri;
    if (is_file($f)) {
        $ext = pathinfo($f, PATHINFO_EXTENSION);
        $mime = ['css'=>'text/css','js'=>'text/javascript','json'=>'application/json'][$ext] ?? 'text/plain';
        header('Content-Type: '.$mime);
        readfile($f);
        exit;
    }
}
$file = __DIR__ . $uri;
if ($uri !== '/' && is_file($file)) return false;
$pub = __DIR__ . '/public' . $uri;
if ($uri !== '/' && is_file($pub)) {
    $ext = pathinfo($pub, PATHINFO_EXTENSION);
    $mime = ['css'=>'text/css','js'=>'text/javascript','html'=>'text/html'][$ext] ?? 'text/plain';
    header('Content-Type: '.$mime);
    readfile($pub);
    exit;
}
require __DIR__ . '/index.php';
