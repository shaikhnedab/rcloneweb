<?php
// Background run monitor for rcloneweb.
// Launched as: php monitor.php <runId> <mode> >/dev/null 2>&1 &
//   mode = 'local' | 'remote'
//
// Reads the command to execute from data/runs/.cmd-<runId> and the run meta
// from data/runs/.pid-<runId>.json, runs it detached with setsid, streams the
// output into the sharded run file, and finalises exitCode/finishedAt.
//
// The whole point: the HTTP request must NOT wait for the backup. This process
// owns proc_open and writes results back so the panel can poll runs/J.

require_once __DIR__.'/Store.php';
require_once __DIR__.'/Runs.php';

$runId = $argv[1] ?? '';
$mode  = $argv[2] ?? 'local';
if ($runId === '') { exit(0); }

$dir = Runs::DIR;
$cmdFile  = $dir.'/.cmd-'.$runId;
$metaFile = $dir.'/.pid-'.$runId.'.json';
if (!file_exists($cmdFile)) exit(0);

$cmd  = trim((string)file_get_contents($cmdFile));
$meta = json_decode((string)@file_get_contents($metaFile), true) ?: [];
if ($cmd === '') exit(0);

$scriptId = $meta['scriptId'] ?? 'script';
$vpsId    = $meta['vpsId'] ?? null;
$dryRun   = !empty($meta['dryRun']);

// Build env: DRY_RUN for local; remote cmd already embeds its prefix.
$env = array_merge(getenv() ?: [], ['TERM'=>'dumb']);
if ($mode === 'local') $env['DRY_RUN'] = $dryRun ? '1' : '0';

// Detach so the child forms its own process group (startedAt group leader).
// setsid bits are set so the child's pgid == its pid → Stop can kill -pid.
$fullCmd = 'setsid '.$cmd; 

$descriptors = [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']];
$proc = proc_open($fullCmd, $descriptors, $pipes, '/tmp', $env, ['setsid'=>true]);
if (!is_resource($proc)) { @unlink($cmdFile); @unlink($metaFile); exit(0); }

$status = proc_get_status($proc);
$pgid = (int)($status['pid'] ?? 0);
// persist real pgid for Stop (setsid => pgid == pid)
file_put_contents($metaFile, json_encode(array_merge($meta, ['pid'=>$pgid]), JSON_UNESCAPED_SLASHES), LOCK_EX);

// We don't want the full cmd echoed; local command may include trailing __EXIT already.
stream_set_blocking($pipes[1], false);
stream_set_blocking($pipes[2], false);
fclose($pipes[0]);

$out = '';
$start = microtime(true);
$outCap = Runs::MAX_OUTPUT;

while (true) {
    $st = proc_get_status($proc);
    $chunk = stream_get_contents($pipes[1]);
    if ($chunk !== false && $chunk !== '') $out .= $chunk;
    $chunk2 = stream_get_contents($pipes[2]);
    if ($chunk2 !== false && $chunk2 !== '') $out .= $chunk2;
    if (strlen($out) > $outCap) $out = substr($out, 0, $outCap);

    // persist incrementally so the panel streams while running
    $runs = Runs::read($scriptId, $vpsId);
    foreach ($runs as &$r) {
        if ($r['id'] === $runId) { $r['output'] = $out; break; }
    }
    unset($r);
    Runs::write($scriptId, $vpsId, $runs);

    if (!$st['running']) break;
    usleep(250000);
}

$out .= stream_get_contents($pipes[1]);
$out .= stream_get_contents($pipes[2]);
fclose($pipes[1]); fclose($pipes[2]);
$code = proc_close($proc);

// parse __EXIT:<n> marker if present (both local+remote append it)
$exit = $code;
if (preg_match('/__EXIT:(\d+)/', $out, $m)) {
    $exit = (int)$m[1];
    $out = str_replace(['__EXIT:'.$m[1]], ['[exit '.$m[1].']'], $out);
}
if (preg_match('/\[exit ([0-9-]+)\]/', $out, $m2)) {
    $code = (int)$m2[1];
}

// final persist
$runs = Runs::read($scriptId, $vpsId);
foreach ($runs as &$r) {
    if ($r['id'] === $runId) {
        $r['output'] = $out;
        $r['finishedAt'] = gmdate('c');
        $r['exitCode'] = $exit;
        break;
    }
}
unset($r);
Runs::write($scriptId, $vpsId, $runs);

// cleanup tmp files
@unlink($cmdFile);
@unlink($metaFile);
if ($mode === 'local') {
    @unlink($meta['tmp'] ?? $dir.'/.run-'.$runId.'.sh');
} elseif (!empty($meta['tmpLocal'])) {
    @unlink($meta['tmpLocal']);
}
if (!empty($vpsId)) { require_once __DIR__.'/Fleet.php'; if (class_exists('Fleet')) Fleet::touchSeen($vpsId); }
exit(0);