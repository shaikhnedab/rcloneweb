<?php
header('X-Content-Type-Options: nosniff');
require_once __DIR__.'/lib/Auth.php';
require_once __DIR__.'/lib/Store.php';
require_once __DIR__.'/lib/Runs.php';
require_once __DIR__.'/lib/Webhook.php';
require_once __DIR__.'/lib/Fleet.php';
require_once __DIR__.'/lib/Destinations.php';
require_once __DIR__.'/lib/ConnectionTest.php';
require_once __DIR__.'/lib/Browse.php';

Store::init(); Runs::init(); Fleet::init(); Destinations::init();
@mkdir(__DIR__.'/../data/schedules',0750,true);
@mkdir(__DIR__.'/../data/runs',0750,true);

function json_body(): array {
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) return [];
    $j = json_decode($raw, true);
    return is_array($j) ? $j : [];
}
function send($code, $body, array $headers=[]): void {
    http_response_code($code);
    foreach ($headers as $k=>$v) header("$k: $v");
    if (is_array($body) || is_object($body)) { header('Content-Type: application/json'); echo json_encode($body, JSON_UNESCAPED_SLASHES); }
    else { header('Content-Type: text/plain; charset=utf-8'); echo $body; }
    exit;
}
function requireAuth(): void {
    $authed = Auth::validSession($_COOKIE['rw_session'] ?? null);
    // allow raw token endpoints without session
    $p = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    if (preg_match('#^/(raw|i)/#', $p)) return;
    if (!$authed) {
        $isApi = str_starts_with($p, '/api/');
        if ($isApi) send(401, ['error'=>'Not logged in']);
        // for non-api let index.php handle SPA
        send(401, 'unauthorized');
    }
}

$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$qs = $_GET;

// ---- auth status always open ----
if ($uri === '/api/auth/status' && $method==='GET') {
    $a = Auth::read();
    $authed = Auth::validSession($_COOKIE['rw_session'] ?? null);
    $user = $authed ? explode('.', $_COOKIE['rw_session'])[0] : null;
    send(200, ['setupNeeded'=> $a===null, 'authenticated'=>$authed, 'username'=>$user]);
}
if ($uri === '/api/auth/setup' && $method==='POST') {
    if (Auth::read() !== null) send(409, ['error'=>'Setup already completed']);
    $b=json_body();
    $u=trim($b['username']??''); $p=$b['password']??'';
    if (!$u || !is_string($p) || strlen($p)<6) send(400, ['error'=>'Username required, password must be at least 6 characters']);
    Auth::create(substr($u,0,40), $p);
    $sess=Auth::makeSession($u);
    send(200, ['ok'=>true], ['Set-Cookie'=>"rw_session=".rawurlencode($sess)."; Path=/; HttpOnly; SameSite=Lax; Max-Age=". (30*24*3600)]);
}
if ($uri === '/api/auth/login' && $method==='POST') {
    $b=json_body();
    if (!Auth::verify((string)($b['username']??''), (string)($b['password']??''))) send(401, ['error'=>'Invalid username or password']);
    $sess=Auth::makeSession((string)$b['username']);
    send(200, ['ok'=>true], ['Set-Cookie'=>"rw_session=".rawurlencode($sess)."; Path=/; HttpOnly; SameSite=Lax; Max-Age=". (30*24*3600)]);
}
if ($uri === '/api/auth/logout' && $method==='POST') {
    send(200, ['ok'=>true], ['Set-Cookie'=>'rw_session=; Path=/; HttpOnly; Max-Age=0']);
}

// ---- raw token endpoints (no session needed) ----
if (preg_match('#^/(?:raw|i)/([^/]+?)(?:\.sh)?$#', $uri, $m)) {
    $id = preg_replace('/\.sh$/i','',$m[1]);
    if (!Store::safeId($id)) send(400, "# bad id\n");
    $doc = Store::read($id);
    if (!$doc || empty($doc['script'])) send(404, "# script not found\n");
    $token = $_GET['token'] ?? '';
    if (empty($doc['rawToken']) || $token !== $doc['rawToken']) send(401, "# unauthorized: append ?token=<token> (see panel → Install)\n");
    header('Content-Type: text/x-shellscript; charset=utf-8');
    header('Cache-Control: no-store');
    echo $doc['script'];
    exit;
}

// ---- auth gate for remaining api ----
if (str_starts_with($uri, '/api/')) {
    if (!Auth::validSession($_COOKIE['rw_session'] ?? null)) send(401, ['error'=>'Not logged in']);
}

// ---- fleet ----
if ($uri === '/api/fleet' && $method==='GET') send(200, Fleet::list());
if ($uri === '/api/fleet' && $method==='POST') {
    $b=json_body();
    if (empty($b['host']) || empty($b['name'])) send(400, ['error'=>'Name and host required']);
    $doc=Fleet::create($b);
    send(201, $doc);
}
if (preg_match('#^/api/fleet/([^/]+)/test$#',$uri,$m) && $method==='POST') {
    if (!Fleet::safeId($m[1])) send(400, ['error'=>'bad id']);
    $res = ConnectionTest::testSource($m[1]);
    send($res['ok']?200:502, $res);
}
if (preg_match('#^/api/fleet/([^/]+)$#',$uri,$m)) {
    $id=$m[1];
    if (!Fleet::safeId($id)) send(400, ['error'=>'bad id']);
    if ($method==='GET') { $d=Fleet::read($id); if(!$d) send(404,['error'=>'not found']); send(200,$d); }
    if ($method==='PUT') { $d=Fleet::update($id, json_body()); if(!$d) send(404,['error'=>'not found']); send(200,$d); }
    if ($method==='DELETE') { Fleet::delete($id); http_response_code(204); exit; }
}

// ---- destinations (destination fleet) ----
if ($uri === '/api/destinations' && $method==='GET') send(200, Destinations::list());
if ($uri === '/api/destinations' && $method==='POST') {
    $b=json_body();
    if (empty($b['name'])) send(400, ['error'=>'Name required']);
    if (empty($b['host']) && ($b['type']??'sftp')!=='s3') send(400, ['error'=>'Host required for sftp/ftp']);
    $doc=Destinations::create($b);
    send(201, $doc);
}
if (preg_match('#^/api/destinations/([^/]+)/test$#',$uri,$m) && $method==='POST') {
    if (!Destinations::safeId($m[1])) send(400, ['error'=>'bad id']);
    $d=Destinations::readDecrypted($m[1]); if(!$d) send(404,['error'=>'not found']);
    // map to ConnectionTest format
    $in=['type'=>$d['type'],'host'=>$d['host'],'port'=>$d['port'],'user'=>$d['user'],'password'=>$d['password']??null,'sftpAuth'=>$d['sftpAuth']??'password','keyPath'=>$d['keyPath']??'','bucket'=>$d['s3Bucket']??'','region'=>$d['s3Region']??'','endpoint'=>$d['s3Endpoint']??'','provider'=>$d['s3Provider']??'AWS','accessKey'=>$d['s3AccessKey']??'','secretKey'=>$d['s3SecretKey']??null];
    $res=ConnectionTest::testDestination($in);
    if ($res['ok']) Destinations::touchSeen($m[1]);
    send($res['ok']?200:502,$res);
}
if (preg_match('#^/api/destinations/([^/]+)/browse$#',$uri,$m) && $method==='POST') {
    if (!Destinations::safeId($m[1])) send(400, ['error'=>'bad id']);
    $d=Destinations::readDecrypted($m[1]); if(!$d) send(404,['error'=>'not found']);
    $b=json_body(); $path=trim($b['path']??'');
    $in=['type'=>$d['type'],'host'=>$d['host'],'port'=>$d['port'],'user'=>$d['user'],'password'=>$d['password']??null,'sftpAuth'=>$d['sftpAuth']??'password','keyPath'=>$d['keyPath']??'','bucket'=>$d['s3Bucket']??'','region'=>$d['s3Region']??'','endpoint'=>$d['s3Endpoint']??'','provider'=>$d['s3Provider']??'AWS','accessKey'=>$d['s3AccessKey']??'','secretKey'=>$d['s3SecretKey']??null,'path'=>$path];
    $res=Browse::browseRemote($in);
    send($res['ok']?200:502,$res);
}
if (preg_match('#^/api/destinations/([^/]+)$#',$uri,$m)) {
    $id=$m[1];
    if (!Destinations::safeId($id)) send(400, ['error'=>'bad id']);
    if ($method==='GET') { $d=Destinations::read($id); if(!$d) send(404,['error'=>'not found']); send(200,$d); }
    if ($method==='PUT') { $d=Destinations::update($id, json_body()); if(!$d) send(404,['error'=>'not found']); send(200,$d); }
    if ($method==='DELETE') { Destinations::delete($id); http_response_code(204); exit; }
}

// ---- connection tests (destination) ----
if ($uri === '/api/test/connection' && $method==='POST') {
    $res = ConnectionTest::testDestination(json_body());
    send($res['ok']?200:502, $res);
}

// ---- mkdir ----
if (preg_match('#^/api/fleet/([^/]+)/mkdir$#',$uri,$m) && $method==='POST') {
    if (!Fleet::safeId($m[1])) send(400,['error'=>'bad id']);
    $b=json_body(); $path=trim($b['path']??'');
    $res=Browse::mkdirVps($m[1], $path);
    send($res['ok']?200:400,$res);
}
if (preg_match('#^/api/destinations/([^/]+)/mkdir$#',$uri,$m) && $method==='POST') {
    if (!Destinations::safeId($m[1])) send(400,['error'=>'bad id']);
    $b=json_body(); $path=trim($b['path']??'');
    // reuse mkdirRemote with fleet's stored creds
    $d=Destinations::readDecrypted($m[1]); if(!$d) send(404,['error'=>'not found']);
    $in=['type'=>$d['type'],'host'=>$d['host'],'port'=>$d['port'],'user'=>$d['user'],'password'=>$d['password']??null,'sftpAuth'=>$d['sftpAuth']??'password','keyPath'=>$d['keyPath']??'','bucket'=>$d['s3Bucket']??'','region'=>$d['s3Region']??'','endpoint'=>$d['s3Endpoint']??'','provider'=>$d['s3Provider']??'AWS','accessKey'=>$d['s3AccessKey']??'','secretKey'=>$d['s3SecretKey']??null,'path'=>$path];
    $res=Browse::mkdirRemote($in);
    send($res['ok']?200:400,$res);
}
if ($uri === '/api/browse/mkdir-remote' && $method==='POST') {
    $res=Browse::mkdirRemote(json_body());
    send($res['ok']?200:400,$res);
}
if ($uri === '/api/browse/mkdir-local' && $method==='POST') {
    $b=json_body(); $path=trim($b['path']??'');
    $res=Browse::mkdirVps(null, $path);
    send($res['ok']?200:400,$res);
}

// ---- browse ----
if (preg_match('#^/api/fleet/([^/]+)/browse$#',$uri,$m) && $method==='POST') {
    if (!Fleet::safeId($m[1])) send(400,['error'=>'bad id']);
    $b=json_body(); $path=trim($b['path']??'/');
    $res=Browse::browseVps($m[1], $path);
    send($res['ok']?200:502,$res);
}
if ($uri === '/api/browse/local' && $method==='POST') {
    $b=json_body(); $path=trim($b['path']??'/');
    $res=Browse::browseVps(null, $path);
    send($res['ok']?200:502,$res);
}
if ($uri === '/api/browse/remote' && $method==='POST') {
    $res=Browse::browseRemote(json_body());
    send($res['ok']?200:502,$res);
}

// ---- scripts ----
if ($uri === '/api/scripts' && $method==='GET') send(200, Store::list());
if ($uri === '/api/scripts' && $method==='POST') {
    $b=json_body();
    $name=trim($b['name']??'untitled') ?: 'untitled';
    $id=Store::slug($name);
    $b['id']=$id; $b['name']=$name; $b['createdAt']=gmdate('c'); $b['updatedAt']=null;
    // enrich dest fleet credentials if selected
    if (!empty($b['destFleetId'])) {
        $d=Destinations::readDecrypted($b['destFleetId']);
        if ($d) {
            $b['config']['dest']['type']=$d['type']??$b['config']['dest']['type']??'sftp';
            $b['config']['dest']['host']=$d['host']??'';
            $b['config']['dest']['port']=$d['port']??'';
            $b['config']['dest']['user']=$d['user']??'';
            $b['config']['dest']['remoteName']=$d['remoteName']??$b['config']['dest']['remoteName']??'my-backup-remote';
            $b['config']['dest']['remotePath']=$d['remotePath']??'/';
            $b['config']['dest']['sftpAuth']=$d['sftpAuth']??'password';
            $b['config']['dest']['keyPath']=$d['keyPath']??'';
            $b['config']['dest']['s3Provider']=$d['s3Provider']??'AWS';
            $b['config']['dest']['s3Bucket']=$d['s3Bucket']??'';
            $b['config']['dest']['s3Region']=$d['s3Region']??'';
            $b['config']['dest']['s3Endpoint']=$d['s3Endpoint']??'';
            // inject secrets for generation (embed)
            if (!empty($d['password'])) { $b['config']['secrets']['password']=$d['password']; $b['config']['secrets']['embed']=true; }
            if (!empty($d['s3AccessKey'])) $b['config']['secrets']['s3AccessKey']=$d['s3AccessKey'];
            if (!empty($d['s3SecretKey'])) { $b['config']['secrets']['s3SecretKey']=$d['s3SecretKey']; $b['config']['secrets']['embed']=true; }
        }
    }
    $doc=Store::write($b);
    send(201,$doc);
}
if (preg_match('#^/api/scripts/([^/]+)$#',$uri,$m)) {
    $id=$m[1];
    if (!Store::safeId($id)) send(400,['error'=>'bad id']);
    if ($method==='GET') { $d=Store::read($id); if(!$d) send(404,['error'=>'not found']); send(200,$d); }
    if ($method==='PUT') {
        $ex=Store::read($id); if(!$ex) send(404,['error'=>'not found']);
        $b=json_body();
        $doc=array_merge($ex,$b);
        $doc['id']=$ex['id']; $doc['createdAt']=$ex['createdAt']; $doc['rawToken']=$ex['rawToken'];
        // enrich dest fleet credentials if selected (so script gets embedded password)
        if (!empty($doc['destFleetId'])) {
            $d=Destinations::readDecrypted($doc['destFleetId']);
            if ($d) {
                $doc['config']['dest']['type']=$d['type']??$doc['config']['dest']['type']??'sftp';
                $doc['config']['dest']['host']=$d['host']??'';
                $doc['config']['dest']['port']=$d['port']??'';
                $doc['config']['dest']['user']=$d['user']??'';
                $doc['config']['dest']['remoteName']=$d['remoteName']??$doc['config']['dest']['remoteName']??'my-backup-remote';
                $doc['config']['dest']['remotePath']=$d['remotePath']??'/';
                $doc['config']['dest']['sftpAuth']=$d['sftpAuth']??'password';
                $doc['config']['dest']['keyPath']=$d['keyPath']??'';
                $doc['config']['dest']['s3Provider']=$d['s3Provider']??'AWS';
                $doc['config']['dest']['s3Bucket']=$d['s3Bucket']??'';
                $doc['config']['dest']['s3Region']=$d['s3Region']??'';
                $doc['config']['dest']['s3Endpoint']=$d['s3Endpoint']??'';
                if (!empty($d['password'])) { $doc['config']['secrets']['password']=$d['password']; $doc['config']['secrets']['embed']=true; }
                if (!empty($d['s3AccessKey'])) $doc['config']['secrets']['s3AccessKey']=$d['s3AccessKey'];
                if (!empty($d['s3SecretKey'])) { $doc['config']['secrets']['s3SecretKey']=$d['s3SecretKey']; $doc['config']['secrets']['embed']=true; }
                // regenerate script from enriched config if not manually edited
                if (empty($doc['manualEdited'])) {
                    // we need to regenerate server-side? For now, let client handle, but ensure secrets are embedded
                    // The client will have sent a stale script; we overwrite with fresh generation if possible
                    // Since we don't have JS generator on PHP, we keep client's script but ensure it will be regenerated on next load
                    // Instead, mark manualEdited false so next save will regenerate
                    $doc['manualEdited']=false;
                }
            }
        }
        Store::write($doc); send(200,$doc);
    }
    if ($method==='DELETE') {
        @unlink(Store::fileFor($id));
        foreach (glob(__DIR__.'/../data/runs/'.$id.'*.json')?:[] as $p) @unlink($p);
        foreach (glob(__DIR__.'/../data/schedules/*_'.$id.'.json')?:[] as $p) @unlink($p);
        http_response_code(204); exit;
    }
}

// ---- webhook test ----
if ($uri === '/api/test-webhook' && $method==='POST') {
    $r=Webhook::test(json_body());
    send($r['code'],$r['body']);
}

// ---- runs ----
if (preg_match('#^/api/scripts/([^/]+)/runs$#',$uri,$m) && $method==='GET') {
    if (!Store::safeId($m[1])) send(400,['error'=>'bad id']);
    // optional ?vpsId= filter; if absent return merged
    $vpsId = $_GET['vpsId'] ?? null;
    if ($vpsId) send(200, Runs::read($m[1], $vpsId));
    send(200, Runs::listAll($m[1]));
}
if (preg_match('#^/api/scripts/([^/]+)/runs$#',$uri,$m) && $method==='DELETE') {
    if (!Store::safeId($m[1])) send(400,['error'=>'bad id']);
    $vpsId = $_GET['vpsId'] ?? null;
    if ($vpsId) {
        @unlink(Runs::fileFor($m[1], $vpsId));
    } else {
        foreach (glob(__DIR__.'/../data/runs/'.$m[1].'*.json')?:[] as $p) @unlink($p);
        foreach (glob(__DIR__.'/../data/runs/'.$m[1].'__*.json')?:[] as $p) @unlink($p);
    }
    // also clear meta pid files
    foreach (glob(__DIR__.'/../data/runs/.pid-*')?:[] as $p) @unlink($p);
    send(200,['ok'=>true]);
}
if (preg_match('#^/api/scripts/([^/]+)/runs/([^/]+)/log$#',$uri,$m) && $method==='GET') {
    if (!Store::safeId($m[1])) send(400,['error'=>'bad id']);
    $runs = Runs::listAll($m[1]);
    foreach ($runs as $r) if ($r['id']===$m[2]) {
        header('Content-Type: text/plain; charset=utf-8');
        header('Content-Disposition: attachment; filename="run-'.$m[2].'.log"');
        echo $r['output'] ?? '';
        exit;
    }
    send(404,['error'=>'run not found']);
}
if (preg_match('#^/api/scripts/([^/]+)/run$#',$uri,$m) && $method==='POST') {
    if (!Store::safeId($m[1])) send(400,['error'=>'bad id']);
    $b=json_body();
    $vpsId = $b['vpsId'] ?? null;
    if ($vpsId === 'local') $vpsId=null;
    if ($vpsId && !Fleet::safeId($vpsId) && $vpsId!=='local') send(400,['error'=>'bad vpsId']);
    // prevent duplicate concurrent runs for same script+vps
    $existing = Runs::read($m[1], $vpsId);
    foreach ($existing as $r) if (empty($r['finishedAt'])) send(409,['error'=>'A run is already in progress for this VPS — wait for it to finish or stop it first']);
    $rec=Runs::start($m[1], !empty($b['dryRun']), $vpsId);
    if (!$rec) send(404,['error'=>'script not found or has no script content']);
    // check if start failed due to duplicate (race)
    if (is_array($rec) && isset($rec['error']) && $rec['error']==='already_running') send(409,['error'=>'A run is already in progress']);
    send(202,$rec);
}
if (preg_match('#^/api/runs/([^/]+)/stop$#',$uri,$m) && $method==='POST') {
    $ok=Runs::stop($m[1]);
    if (!$ok) send(404,['error'=>'run not active']);
    send(200,['ok'=>true]);
}

// ---- schedules (per-vps cron) ----
if ($uri === '/api/schedules' && $method==='GET') {
    $scriptId=$_GET['scriptId']??null;
    $out=[];
    foreach (glob(__DIR__.'/../data/schedules/*.json')?:[] as $p) {
        $d=json_decode((string)file_get_contents($p),true);
        if (!$d) continue;
        if ($scriptId && ($d['scriptId']??'')!==$scriptId) continue;
        $out[]=$d;
    }
    send(200,$out);
}
if ($uri === '/api/schedules' && $method==='POST') {
    $b=json_body();
    if (empty($b['scriptId'])||empty($b['vpsId'])||empty($b['cronExpr'])) send(400,['error'=>'scriptId, vpsId, cronExpr required']);
    $id=bin2hex(random_bytes(6));
    $tz = $b['timezone'] ?? 'UTC';
    // validate timezone
    try { new DateTimeZone($tz); } catch (Exception $e) { $tz='UTC'; }
    $doc=['id'=>$id,'scriptId'=>$b['scriptId'],'vpsId'=>$b['vpsId'],'cronExpr'=>$b['cronExpr'],'timezone'=>$tz,'enabled'=>($b['enabled']??true)?true:false,'createdAt'=>gmdate('c')];
    file_put_contents(__DIR__.'/../data/schedules/'.$id.'.json', json_encode($doc, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES), LOCK_EX);
    send(201,$doc);
}
if ($uri === '/api/schedules/trigger' && $method==='POST') {
    $triggered=[];
    foreach (glob(__DIR__.'/../data/schedules/*.json')?:[] as $p) {
        $s=json_decode((string)file_get_contents($p),true);
        if (!$s || empty($s['enabled'])) continue;
        $expr=$s['cronExpr']??'';
        $tz=$s['timezone']??'UTC';
        // use timezone-aware matching
        try { $nowDt=new DateTime('now', new DateTimeZone($tz)); } catch (Exception $e) { $nowDt=new DateTime('now', new DateTimeZone('UTC')); $tz='UTC'; }
        $now=['minutes'=>(int)$nowDt->format('i'),'hours'=>(int)$nowDt->format('G'),'mday'=>(int)$nowDt->format('j'),'mon'=>(int)$nowDt->format('n'),'wday'=>(int)$nowDt->format('w')];
        $parts=preg_split('/\s+/', trim($expr));
        if (count($parts)!==5) continue;
        [$mi,$h,$dom,$mon,$dow]= $parts;
        $checks=[[$mi,$now['minutes']],[$h,$now['hours']],[$dom,$now['mday']],[$mon,$now['mon']],[$dow,$now['wday']]];
        $due=true;
        foreach ($checks as [$field,$val]) {
            if ($field==='*') continue;
            if (str_starts_with($field,'*/')) { $n=(int)substr($field,2); if ($n>0 && $val % $n !==0) {$due=false; break;} continue; }
            if (str_contains($field,',')) { $list=array_map('intval', explode(',',$field)); if (!in_array($val,$list,true)) {$due=false; break;} continue; }
            if ((int)$field !== $val) {$due=false; break;}
        }
        if (!$due) continue;
        $last=$s['lastRun']??null;
        if ($last && (time() - strtotime($last) < 90)) continue;
        $vpsId=$s['vpsId']??null; if ($vpsId==='local') $vpsId=null;
        $rec=Runs::start($s['scriptId'], false, $vpsId);
        if ($rec) {
            $s['lastRun']=gmdate('c');
            file_put_contents($p, json_encode($s, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES), LOCK_EX);
            $triggered[]=$rec;
        }
    }
    send(200,['triggered'=>$triggered,'count'=>count($triggered)]);
}
if ($uri === '/api/scheduler/status' && $method==='GET') {
    $schedules=glob(__DIR__.'/../data/schedules/*.json')?:[];
    $enabled=0; foreach ($schedules as $p) { $d=json_decode((string)file_get_contents($p),true); if (!empty($d['enabled'])) $enabled++; }
    $nextCheck = date('c', (int)(ceil(time()/60)*60));
    send(200,['total'=>count($schedules),'enabled'=>$enabled,'nextCheck'=>$nextCheck,'now'=>gmdate('c')]);
}
if (preg_match('#^/api/schedules/([^/]+)$#',$uri,$m)) {
    $id=$m[1];
    $f=__DIR__.'/../data/schedules/'.$id.'.json';
    if ($method==='GET') { if(!file_exists($f)) send(404,['error'=>'not found']); send(200, json_decode((string)file_get_contents($f),true)); }
    if ($method==='PUT') { if(!file_exists($f)) send(404,['error'=>'not found']); $d=json_decode((string)file_get_contents($f),true); $b=json_body(); $d=array_merge($d,$b); $d['id']=$id; file_put_contents($f, json_encode($d, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES), LOCK_EX); send(200,$d); }
    if ($method==='DELETE') { @unlink($f); http_response_code(204); exit; }
}

send(404,['error'=>'not found']);
