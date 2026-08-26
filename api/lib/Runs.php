<?php
class Runs {
    const DIR = __DIR__ . '/../../data/runs';
    const MAX_RUNS = 25;
    const MAX_OUTPUT = 200*1024;

    static function init(): void { @mkdir(self::DIR,0750,true); }

    // sharded file: local = <scriptId>.json, remote = <scriptId>__<vpsId>.json
    static function fileFor(string $scriptId, ?string $vpsId): string {
        if ($vpsId && $vpsId !== 'local') return self::DIR.'/'.$scriptId.'__'.$vpsId.'.json';
        return self::DIR.'/'.$scriptId.'.json';
    }

    static function read(string $scriptId, ?string $vpsId=null): array {
        $f=self::fileFor($scriptId,$vpsId);
        if (!file_exists($f)) return [];
        $j=json_decode((string)file_get_contents($f),true);
        return is_array($j)?$j:[];
    }

    static function write(string $scriptId, ?string $vpsId, array $runs): void {
        file_put_contents(self::fileFor($scriptId,$vpsId), json_encode(array_slice($runs,0,self::MAX_RUNS), JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES), LOCK_EX);
    }

    static function listAll(string $scriptId): array {
        // return merged list across all vps shards for this script
        $all=[];
        foreach (glob(self::DIR.'/'.$scriptId.'*.json')?:[] as $p) {
            $j=json_decode((string)file_get_contents($p),true);
            if (is_array($j)) foreach ($j as $r) $all[]=$r;
        }
        // also legacy single file already included via glob
        usort($all, fn($a,$b)=>strcmp($b['startedAt']??'',$a['startedAt']??''));
        return array_slice($all,0,self::MAX_RUNS);
    }

    // start a run: local or remote via SSH
    static function start(string $scriptId, bool $dryRun, ?string $vpsId): ?array {
        $doc = Store::read($scriptId);
        if (!$doc || empty($doc['script'])) return null;
        // prevent duplicate concurrent runs for same script+vps
        $existing = self::read($scriptId, $vpsId);
        foreach ($existing as $r) if (empty($r['finishedAt'])) return null;
        $runId = base_convert((string)(int)(microtime(true)*1000),10,36).bin2hex(random_bytes(3));
        $targetLabel = $vpsId ? (Fleet::read($vpsId)['name']??$vpsId) : 'localhost';
        $rec = [
            'id'=>$runId,'scriptId'=>$scriptId,'vpsId'=>$vpsId?:'local','vpsName'=>$targetLabel,
            'name'=>$doc['name'],'dryRun'=>$dryRun,'startedAt'=>gmdate('c'),
            'finishedAt'=>null,'exitCode'=>null,'output'=>'',
        ];

        if (!$vpsId || $vpsId==='local') {
            return self::startLocal($scriptId,$vpsId,$doc,$rec,$dryRun);
        } else {
            return self::startRemote($scriptId,$vpsId,$doc,$rec,$dryRun);
        }
    }

    private static function startLocal(string $scriptId, ?string $vpsId, array $doc, array $rec, bool $dryRun): array {
        $runId=$rec['id'];
        $tmp = self::DIR.'/.run-'.$runId.'.sh';
        file_put_contents($tmp, $doc['script']);
        @chmod($tmp,0700);

        $descriptors = [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']];
        $env = array_merge((getenv()?:[]), ['DRY_RUN'=>$dryRun?'1':'0','TERM'=>'dumb']);
        // use setsid-friendly command via bash
        $proc = proc_open('bash '.escapeshellarg($tmp), $descriptors, $pipes, '/tmp', $env);
        if (!is_resource($proc)) { @unlink($tmp); return null; }
        // close stdin
        fclose($pipes[0]);
        // non-blocking read via stream_set_blocking false + poll
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        // persist immediately
        $runs=self::read($scriptId,$vpsId);
        array_unshift($runs,$rec);
        self::write($scriptId,$vpsId,$runs);

        // background monitor
        $pid = null;
        $status = proc_get_status($proc);
        $pid = $status['pid'] ?? null;

        // fork monitor via nohup-like background poller: we use a detached helper
        // simplest: poll in same request but with timeout? For PHP-FPM we need async.
        // Use fastcgi_finish_request if available, then loop.
        if (function_exists('fastcgi_finish_request')) {
            // send 202 already sent by caller; continue in background
        }

        // store pid for stop
        $metaFile = self::DIR.'/.pid-'.$runId.'.json';
        file_put_contents($metaFile, json_encode(['pid'=>$pid,'tmp'=>$tmp,'scriptId'=>$scriptId,'vpsId'=>$vpsId]), LOCK_EX);

        // async monitor: spawn a background php process to watch
        $monitorPhp = __DIR__.'/monitor.php';
        // monitor.php will be created alongside
        if (file_exists($monitorPhp)) {
            $cmd = 'php '.escapeshellarg($monitorPhp).' '.escapeshellarg($runId).' '.escapeshellarg($scriptId).' '.escapeshellarg($vpsId?:'local').' > /dev/null 2>&1 &';
            @exec($cmd);
        } else {
            // fallback: synchronous poll with timeout (still works for short scripts)
            self::pollProc($proc,$pipes,$runId,$scriptId,$vpsId,$tmp,$rec);
        }
        return $rec;
    }

    private static function startRemote(string $scriptId, string $vpsId, array $doc, array $rec, bool $dryRun): ?array {
        $vps = Fleet::readDecrypted($vpsId);
        if (!$vps || empty($vps['host'])) return null;
        $runId=$rec['id'];
        $tmpLocal = self::DIR.'/.run-'.$runId.'.sh';
        file_put_contents($tmpLocal, $doc['script']);
        @chmod($tmpLocal,0600);

        $remoteTmp = '/tmp/rcloneweb-'.$runId.'.sh';

        // build ssh/scp commands
        if (empty($vps['host']) || empty($vps['user'])) return null;
        $port = (int)($vps['port']??22);
        $host = $vps['host']; $user=$vps['user'];
        $hasSshpass = trim((string)shell_exec('which sshpass 2>/dev/null'));
        $usePass = (!empty($vps['password']) && $hasSshpass && ($vps['auth']??'password')==='password');
        $sshPassPrefix = $usePass ? 'sshpass -p '.escapeshellarg($vps['password']).' ' : '';
        // For password auth via sshpass, BatchMode must be OFF; for key auth, keep it ON
        $batchMode = $usePass ? 'no' : 'yes';
        $sshOpts = '-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode='.$batchMode.' -o PreferredAuthentications='.($usePass ? 'password,keyboard-interactive' : 'publickey').' -p '.(int)$port;
        if (($vps['auth']??'password')==='key' && !empty($vps['keyPath'])) $sshOpts .= ' -i '.escapeshellarg($vps['keyPath']);
        $sshCmd = $sshPassPrefix.'ssh '.$sshOpts.' '.$user.'@'.$host;
        $scpOpts = '-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode='.$batchMode.' -P '.(int)$port;
        if (($vps['auth']??'password')==='key' && !empty($vps['keyPath'])) $scpOpts .= ' -i '.escapeshellarg($vps['keyPath']);
        $scpCmd = $sshPassPrefix.'scp '.$scpOpts.' '.escapeshellarg($tmpLocal).' '.escapeshellarg($user.'@'.$host.':'.$remoteTmp);
        $scpOk = self::execTimeout($scpCmd, 15);
        if ($scpOk['code'] !== 0) {
            $rec['output'] = "SCP failed:\n".$scpOk['out'];
            $rec['finishedAt']=gmdate('c'); $rec['exitCode']=127;
            $runs=self::read($scriptId,$vpsId); array_unshift($runs,$rec); self::write($scriptId,$vpsId,$runs);
            @unlink($tmpLocal);
            return $rec;
        }

        // 2) run remotely: chmod + bash
        $envPrefix = $dryRun ? 'DRY_RUN=1 ' : 'DRY_RUN=0 ';
        $remoteCmd = $envPrefix.'chmod 700 '.escapeshellarg($remoteTmp).' && bash '.escapeshellarg($remoteTmp).' 2>&1; echo __EXIT:$?';
        $fullSsh = $sshCmd.' '.escapeshellarg($remoteCmd);

        // store meta for polling
        $rec['output'] = "[remote] executing on {$vps['host']}...\n";
        $runs=self::read($scriptId,$vpsId); array_unshift($runs,$rec); self::write($scriptId,$vpsId,$runs);

        // run async via background ssh
        $metaFile = self::DIR.'/.pid-'.$runId.'.json';
        file_put_contents($metaFile, json_encode(['remote'=>true,'vpsId'=>$vpsId,'remoteTmp'=>$remoteTmp,'scriptId'=>$scriptId,'tmpLocal'=>$tmpLocal]), LOCK_EX);

        $monitorPhp = __DIR__.'/monitor_remote.php';
        if (file_exists($monitorPhp)) {
            $cmd = 'php '.escapeshellarg($monitorPhp).' '.escapeshellarg($runId).' > /dev/null 2>&1 &';
            @exec($cmd);
            // also kick immediate ssh in background via monitor
            file_put_contents(self::DIR.'/.cmd-'.$runId, $fullSsh);
        } else {
            // synchronous fallback (blocks request but still records)
            $r = self::execTimeout($fullSsh, 600);
            $rec['output'] .= $r['out'];
            $rec['finishedAt']=gmdate('c');
            // parse exit
            if (preg_match('/__EXIT:(\d+)\s*$/',$r['out'],$m)) $rec['exitCode']=(int)$m[1]; else $rec['exitCode']=$r['code'];
            $rec['output'] = str_replace("__EXIT:{$rec['exitCode']}",'', $rec['output']);
            $runs=self::read($scriptId,$vpsId);
            // replace first entry
            foreach ($runs as &$x) if ($x['id']===$runId) $x=$rec;
            self::write($scriptId,$vpsId,$runs);
            @unlink($tmpLocal);
            Fleet::touchSeen($vpsId);
        }
        return $rec;
    }

    static function buildSshBase(array $vps): ?string {
        $port = (int)($vps['port']??22);
        $host = $vps['host'];
        $user = $vps['user'];
        if (!$host || !$user) return null;
        $hasSshpass = !empty($vps['password']) && trim((string)shell_exec('which sshpass 2>/dev/null'));
        $usePass = $hasSshpass && ($vps['auth']??'password')==='password';
        $batchMode = $usePass ? 'no' : 'yes';
        $pref = $usePass ? 'password,keyboard-interactive' : 'publickey';
        $opts = '-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode='.$batchMode.' -o PreferredAuthentications='.$pref.' -p '.(int)$port;
        if (($vps['auth']??'password')==='key' && !empty($vps['keyPath'])) {
            $opts .= ' -i '.escapeshellarg($vps['keyPath']);
        }
        if ($usePass) {
            return 'sshpass -p '.escapeshellarg($vps['password']).' ssh '.$opts.' '.$user.'@'.$host;
        }
        return 'ssh '.$opts.' '.$user.'@'.$host;
        // Note: caller appends command separately for remote case, so this returns base without duplicate host
    }

    // helper for ssh base that returns array for easier composition
    static function sshBaseParts(array $vps): array {
        // not used currently
        return [];
    }

    static function execTimeout(string $cmd, int $timeout): array {
        $descriptors=[1=>['pipe','w'],2=>['pipe','w']];
        $proc=proc_open($cmd,$descriptors,$pipes);
        if (!is_resource($proc)) return ['code'=>127,'out'=>'proc_open failed'];
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $out=''; $start=time();
        while (true) {
            $st=proc_get_status($proc);
            $out.=stream_get_contents($pipes[1]);
            $out.=stream_get_contents($pipes[2]);
            if (!$st['running']) break;
            if (time()-$start > $timeout) { proc_terminate($proc,9); $out.="\n[timeout after {$timeout}s]"; break; }
            usleep(100000);
        }
        $out.=stream_get_contents($pipes[1]);
        $out.=stream_get_contents($pipes[2]);
        fclose($pipes[1]); fclose($pipes[2]);
        $code=proc_close($proc);
        return ['code'=>$code,'out'=>$out];
    }

    private static function pollProc($proc, array $pipes, string $runId, string $scriptId, ?string $vpsId, string $tmp, array $rec): void {
        $out='';
        while (true) {
            $st=proc_get_status($proc);
            $chunk=stream_get_contents($pipes[1]); $chunk2=stream_get_contents($pipes[2]);
            if ($chunk!==false) $out.=$chunk;
            if ($chunk2!==false) $out.=$chunk2;
            if (strlen($out) > self::MAX_OUTPUT) $out=substr($out,0,self::MAX_OUTPUT);
            // update rec
            $runs=self::read($scriptId,$vpsId);
            foreach ($runs as &$r) if ($r['id']===$runId) { $r['output']=$out; break; }
            self::write($scriptId,$vpsId,$runs);
            if (!$st['running']) {
                $out.=stream_get_contents($pipes[1]); $out.=stream_get_contents($pipes[2]);
                fclose($pipes[1]); fclose($pipes[2]);
                $code=proc_close($proc);
                $runs=self::read($scriptId,$vpsId);
                foreach ($runs as &$r) if ($r['id']===$runId) { $r['output']=$out; $r['finishedAt']=gmdate('c'); $r['exitCode']=$code; break; }
                self::write($scriptId,$vpsId,$runs);
                @unlink($tmp);
                @unlink(self::DIR.'/.pid-'.$runId.'.json');
                break;
            }
            usleep(200000);
        }
    }

    static function stop(string $runId): bool {
        $metaFile=self::DIR.'/.pid-'.$runId.'.json';
        if (!file_exists($metaFile)) return false;
        $meta=json_decode((string)file_get_contents($metaFile),true);
        if (!empty($meta['remote'])) {
            // remote stop: ssh pkill
            $vps=Fleet::readDecrypted($meta['vpsId']??'');
            if ($vps) {
                $base=self::buildSshBase($vps);
                // base currently includes host; need to extract for pkill
                // simpler: rebuild ssh without duplicate host logic
                $host=$vps['host']; $user=$vps['user']; $port=(int)($vps['port']??22);
                $hasSshpass = !empty($vps['password']) && trim((string)shell_exec('which sshpass 2>/dev/null'));
                $usePass = $hasSshpass && ($vps['auth']??'password')==='password';
                $batchMode = $usePass ? 'no' : 'yes';
                $pref = $usePass ? 'password,keyboard-interactive' : 'publickey';
                $keyOpt = ($vps['auth']??'password')==='key' && !empty($vps['keyPath']) ? ' -i '.escapeshellarg($vps['keyPath']) : '';
                $opts='-o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode='.$batchMode.' -o PreferredAuthentications='.$pref.' -p '.$port.$keyOpt;
                $ssh="ssh $opts $user@$host";
                if ($usePass) {
                    $ssh='sshpass -p '.escapeshellarg($vps['password']).' '.$ssh;
                }
                @exec($ssh.' '.escapeshellarg('pkill -f rcloneweb-'.$runId.'; pkill -TERM -f rclone; true').' > /dev/null 2>&1 &');
            }
            // mark as stopped
            $scriptId=$meta['scriptId']??''; $vpsId=$meta['vpsId']??null;
            if ($scriptId) {
                $runs=self::read($scriptId,$vpsId);
                foreach ($runs as &$r) if ($r['id']===$runId && empty($r['finishedAt'])) { $r['finishedAt']=gmdate('c'); $r['exitCode']=143; $r['output'].="\n[stopped by user]"; }
                self::write($scriptId,$vpsId,$runs);
            }
            @unlink($metaFile);
            return true;
        }
        // local: kill process group
        $pid=(int)($meta['pid']??0);
        if ($pid>0) {
            if (function_exists('posix_kill')) { @posix_kill(-$pid, 15); usleep(500000); @posix_kill(-$pid, 9); }
            else @exec('kill -TERM -'.$pid.' 2>/dev/null; sleep 0.5; kill -KILL -'.$pid.' 2>/dev/null');
        }
        return true;
    }
}
