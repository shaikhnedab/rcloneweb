<?php
// cron dispatcher — run every minute via: * * * * * php /home/opencode/rcloneweb/cron.php >> /var/log/rcloneweb-cron.log 2>&1
require_once __DIR__.'/api/lib/Store.php';
require_once __DIR__.'/api/lib/Runs.php';
require_once __DIR__.'/api/lib/Auth.php';
require_once __DIR__.'/api/lib/Fleet.php';

$schedules = glob(__DIR__.'/data/schedules/*.json') ?: [];
foreach ($schedules as $p) {
    $s = json_decode((string)file_get_contents($p), true);
    if (!$s || empty($s['enabled']) || empty($s['cronExpr']) || empty($s['scriptId'])) continue;
    // timezone-aware cron match (schedule stores browser timezone, fallback to UTC)
    $tz = $s['timezone'] ?? 'UTC';
    if (!cronMatches($s['cronExpr'], $tz)) continue;
    // debounce: skip if already ran in last 90s
    $last = $s['lastRun'] ?? null;
    if ($last && (time() - strtotime($last) < 90)) continue;
    $vpsId = $s['vpsId'] ?? null;
    if ($vpsId === 'local') $vpsId = null;
    $rec = Runs::start($s['scriptId'], false, $vpsId);
    if ($rec) {
        $s['lastRun'] = gmdate('c');
        file_put_contents($p, json_encode($s, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES), LOCK_EX);
    }
}

function cronMatches(string $expr, ?string $tz = null): bool {
    $parts = preg_split('/\s+/', trim($expr));
    if (count($parts) !== 5) return false;
    [$mi,$h,$dom,$mon,$dow] = $parts;
    $now = $tz ? (new DateTime('now', new DateTimeZone($tz)) ) : new DateTime();
    $data = [
        'minutes' => (int)$now->format('i'),
        'hours'   => (int)$now->format('G'),
        'mday'    => (int)$now->format('j'),
        'mon'     => (int)$now->format('n'),
        'wday'    => (int)$now->format('w'),
    ];
    $checks = [
        [$mi, $data['minutes']],
        [$h,  $data['hours']],
        [$dom,$data['mday']],
        [$mon,$data['mon']],
        [$dow,$data['wday']],
    ];
    foreach ($checks as [$field,$val]) {
        if ($field === '*') continue;
        if (str_starts_with($field, '*/')) { $n=(int)substr($field,2); if ($n>0 && $val % $n !== 0) return false; continue; }
        if (str_contains($field, ',')) { $list=array_map('intval', explode(',',$field)); if (!in_array($val,$list,true)) return false; continue; }
        if ((int)$field !== $val) return false;
    }
    return true;
}
