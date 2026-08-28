<?php
class Browse {
    // Browse VPS filesystem via SSH (or local if vpsId is null/local)
    static function browseVps(?string $vpsId, string $path): array {
        $path = trim($path) ?: '/';
        if (!$vpsId || $vpsId === 'local') {
            // local filesystem
            $real = realpath($path) ?: $path;
            if (!is_dir($real) && !is_file($real)) $real = dirname($real);
            if (!is_dir($real)) return ['ok'=>false,'msg'=>'Path not found','path'=>$path,'entries'=>[]];
            $entries = [];
            $dh = @opendir($real);
            if ($dh) {
                while (($e = readdir($dh)) !== false) {
                    if ($e === '.' ) continue;
                    $full = rtrim($real,'/').'/'.$e;
                    $isDir = is_dir($full);
                    $entries[] = ['name'=>$e, 'path'=>$full, 'isDir'=>$isDir];
                }
                closedir($dh);
            }
            usort($entries, fn($a,$b)=> ($b['isDir'] <=> $a['isDir']) ?: strcmp($a['name'],$b['name']));
            // add parent
            $parent = dirname(rtrim($real,'/'));
            if ($parent !== $real) array_unshift($entries, ['name'=>'..','path'=>$parent,'isDir'=>true,'isParent'=>true]);
            return ['ok'=>true,'path'=>$real,'entries'=>$entries];
        }

        $vps = Fleet::readDecrypted($vpsId);
        if (!$vps) return ['ok'=>false,'msg'=>'VPS not found','path'=>$path,'entries'=>[]];
        $host=$vps['host']; $user=$vps['user']; $port=(int)($vps['port']??22);
        $hasSshpass = trim((string)shell_exec('which sshpass 2>/dev/null'));
        $usePass = (!empty($vps['password']) && $hasSshpass && ($vps['auth']??'password')==='password');
        $sshPassPrefix = $usePass ? 'sshpass -p '.escapeshellarg($vps['password']).' ' : '';
        $batchMode = $usePass ? 'no' : 'yes';
        $pref = $usePass ? 'password,keyboard-interactive' : 'publickey';
        $sshOpts = '-o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode='.$batchMode.' -o PreferredAuthentications='.$pref.' -p '.(int)$port;
        if (($vps['auth']??'password')==='key' && !empty($vps['keyPath'])) $sshOpts .= ' -i '.escapeshellarg($vps['keyPath']);
        // Use ls -1 -p to mark dirs with /, and handle spaces
        $safePath = str_replace("'", "'\\''", $path);
        $cmd = $sshPassPrefix.'ssh '.$sshOpts.' '.$user.'@'.$host.' '.escapeshellarg("ls -1 -p --group-directories-first '$safePath' 2>&1; echo __EXIT:\$?; pwd 2>&1");
        $out = trim((string)shell_exec('timeout 15 '.$cmd.' 2>&1; echo __EXIT:$?'));
        // Parse: last __EXIT is from outer timeout, second last is from ls pwd block
        // Simpler: just split
        $lines = explode("\n", $out);
        // Extract exit codes
        $exit = 0;
        if (preg_match('/__EXIT:(\d+)\s*$/', $out, $m)) { /* use last? */ }
        if (str_contains($out, 'Permission denied')) {
            return ['ok'=>false,'msg'=>'SSH Permission denied — verify password, PasswordAuthentication & PermitRootLogin on '. $host,'path'=>$path,'entries'=>[]];
        }
        // For now, check if output contains "No such file"
        if (str_contains($out, 'No such file') || str_contains($out, 'cannot access')) {
            return ['ok'=>false,'msg'=>'Path not found: '.$path,'path'=>$path,'entries'=>[]];
        }
        // Filter entries: remove __EXIT lines and empty
        $entries = [];
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '__EXIT:')) continue;
            // pwd line at end might be path itself, skip if equals requested path
            if ($line === $path) continue;
            // ls with -p appends / for dirs
            $isDir = str_ends_with($line, '/');
            $name = $isDir ? rtrim($line,'/') : $line;
            if ($name === '') continue;
            // Reconstruct full path
            $full = rtrim($path,'/').'/'.$name;
            $entries[] = ['name'=>$name, 'path'=>$full, 'isDir'=>$isDir];
        }
        // Sort dirs first
        usort($entries, fn($a,$b)=> ($b['isDir'] <=> $a['isDir']) ?: strcmp($a['name'],$b['name']));
        // Add parent
        $parent = dirname(rtrim($path,'/'));
        if ($parent !== $path && $parent !== '.') array_unshift($entries, ['name'=>'..','path'=>$parent,'isDir'=>true,'isParent'=>true]);
        return ['ok'=>true,'path'=>$path,'entries'=>$entries];
    }

    // Browse remote storage via rclone lsjson (ephemeral remote)
    static function browseRemote(array $in): array {
        $type = $in['type'] ?? '';
        $path = trim($in['path'] ?? '') ?: '';
        // Reuse ConnectionTest logic to create ephemeral remote, then lsjson
        $rclone = trim((string)shell_exec('which rclone 2>/dev/null'));
        if (!$rclone) return ['ok'=>false,'msg'=>'rclone not found','path'=>$path,'entries'=>[]];

        $host = trim($in['host'] ?? '');
        $port = trim((string)($in['port'] ?? ''));
        $user = trim($in['user'] ?? '');
        $pass = $in['password'] ?? null;
        $sftpAuth = $in['sftpAuth'] ?? 'password';
        $keyPath = trim($in['keyPath'] ?? '');
        $bucket = trim($in['bucket'] ?? $in['s3Bucket'] ?? '');
        $region = trim($in['region'] ?? $in['s3Region'] ?? '');
        $endpoint = trim($in['endpoint'] ?? $in['s3Endpoint'] ?? '');
        $provider = trim($in['provider'] ?? $in['s3Provider'] ?? 'AWS');
        $accessKey = trim($in['accessKey'] ?? $in['s3AccessKey'] ?? '');
        $secretKey = $in['secretKey'] ?? $in['s3SecretKey'] ?? null;

        // Inline rclone backend params (no config file written — works even when
        // /var/www is unwritable by www-data). Uses rclone's :backend: syntax.
        if ($type === 'sftp') {
            if ($sftpAuth === 'key') {
                if (!$keyPath) return ['ok'=>false,'msg'=>'SSH key path required','path'=>$path,'entries'=>[]];
                $flags = ['--sftp-host='.escapeshellarg($host), '--sftp-user='.escapeshellarg($user), '--sftp-port='.escapeshellarg($port ?: '22'), '--sftp-key-file='.escapeshellarg($keyPath)];
            } else {
                if ($pass === null || $pass === '') return ['ok'=>false,'msg'=>'Password required','path'=>$path,'entries'=>[]];
                $obscured = trim((string)shell_exec('rclone obscure '.escapeshellarg($pass).' 2>/dev/null'));
                $flags = ['--sftp-host='.escapeshellarg($host), '--sftp-user='.escapeshellarg($user), '--sftp-port='.escapeshellarg($port ?: '22'), '--sftp-pass='.escapeshellarg($obscured)];
            }
        } elseif ($type === 'ftp') {
            if ($pass === null || $pass === '') return ['ok'=>false,'msg'=>'Password required','path'=>$path,'entries'=>[]];
            $obscured = trim((string)shell_exec('rclone obscure '.escapeshellarg($pass).' 2>/dev/null'));
            $flags = ['--ftp-host='.escapeshellarg($host), '--ftp-user='.escapeshellarg($user), '--ftp-port='.escapeshellarg($port ?: '21'), '--ftp-pass='.escapeshellarg($obscured)];
        } elseif ($type === 's3') {
            if ($accessKey === '' || $secretKey === null || $secretKey === '') return ['ok'=>false,'msg'=>'Access key/secret required','path'=>$path,'entries'=>[]];
            $flags = ['--s3-provider='.escapeshellarg($provider), '--s3-region='.escapeshellarg($region), '--s3-access-key-id='.escapeshellarg($accessKey), '--s3-secret-access-key='.escapeshellarg($secretKey)];
            if ($endpoint) $flags[] = '--s3-endpoint='.escapeshellarg($endpoint);
        } else {
            return ['ok'=>false,'msg'=>'Unknown remote type','path'=>$path,'entries'=>[]];
        }
        $flagStr = implode(' ', $flags);
        $backend = ':'.$type.':';
        // normalize path: for s3, path is bucket/path or just path
        if ($type === 's3' && $path === '' && $bucket) $remotePath = $backend . $bucket;
        elseif ($type === 's3' && $bucket && !str_starts_with($path, $bucket)) $remotePath = $backend . $bucket . '/' . ltrim($path,'/');
        else $remotePath = $backend . ltrim($path, '/');

        // point rclone at a writable temp config so it doesn't try to write /var/www/.rclone.conf
        $tmpCfg = '/tmp/rclone-rw-'.getmypid().'.conf';
        $lsCmd = 'timeout 15 rclone lsjson --config '.escapeshellarg($tmpCfg).' '.escapeshellarg($remotePath).' '.$flagStr.' 2>&1';
        $out = trim((string)shell_exec($lsCmd));
        // no cleanup needed — nothing was written to any config file

        // rclone prints NOTICE lines to stderr (merged via 2>&1); extract the JSON
        // array instead of assuming $out starts with '['
        if (preg_match('/\[.*\]/s', $out, $jm) && is_array($j = json_decode($jm[0], true))) {
            $j = json_decode($out, true);
            if (is_array($j)) {
                $entries = [];
                foreach ($j as $e) {
                    $name = $e['Name'] ?? $e['name'] ?? '';
                    $isDir = $e['IsDir'] ?? $e['isDir'] ?? false;
                    $full = rtrim($path,'/').'/'.$name;
                    if ($path === '' ) $full = $name;
                    $entries[] = ['name'=>$name, 'path'=>$full, 'isDir'=>$isDir];
                }
                usort($entries, fn($a,$b)=> ($b['isDir'] <=> $a['isDir']) ?: strcmp($a['name'],$b['name']));
                // parent
                if ($path !== '' && $path !== '/') {
                    $parent = dirname(rtrim($path,'/'));
                    if ($parent === '.') $parent = '';
                    array_unshift($entries, ['name'=>'..','path'=>$parent,'isDir'=>true,'isParent'=>true]);
                }
                return ['ok'=>true,'path'=>$path,'entries'=>$entries];
            }
        }
        // fallback: check error
        if (str_contains($out, 'directory not found') || str_contains($out, 'not found')) {
            return ['ok'=>true,'path'=>$path,'entries'=>[]];
        }
        return ['ok'=>false,'msg'=>substr($out,0,400) ?: 'Failed to list','path'=>$path,'entries'=>[]];
    }

    static function mkdirVps(?string $vpsId, string $path): array {
        $path = trim($path);
        if ($path === '' || $path === '/') return ['ok'=>false,'msg'=>'Enter a folder name'];
        if (!$vpsId || $vpsId === 'local') {
            $ok = @mkdir($path, 0755, true);
            if (!$ok && !is_dir($path)) return ['ok'=>false,'msg'=>'mkdir failed: '.error_get_last()['message']??'unknown'];
            return ['ok'=>true,'msg'=>'Created '.$path];
        }
        $vps = Fleet::readDecrypted($vpsId);
        if (!$vps) return ['ok'=>false,'msg'=>'VPS not found'];
        $host=$vps['host']; $user=$vps['user']; $port=(int)($vps['port']??22);
        $hasSshpass = trim((string)shell_exec('which sshpass 2>/dev/null'));
        $usePass = (!empty($vps['password']) && $hasSshpass && ($vps['auth']??'password')==='password');
        $sshPassPrefix = $usePass ? 'sshpass -p '.escapeshellarg($vps['password']).' ' : '';
        $batchMode = $usePass ? 'no' : 'yes';
        $pref = $usePass ? 'password,keyboard-interactive' : 'publickey';
        $sshOpts = '-o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode='.$batchMode.' -o PreferredAuthentications='.$pref.' -p '.(int)$port;
        if (($vps['auth']??'password')==='key' && !empty($vps['keyPath'])) $sshOpts .= ' -i '.escapeshellarg($vps['keyPath']);
        $safe = str_replace("'", "'\\''", $path);
        $cmd = $sshPassPrefix.'ssh '.$sshOpts.' '.$user.'@'.$host.' '.escapeshellarg("mkdir -p '$safe' 2>&1; echo __EXIT:\$?");
        $out = trim((string)shell_exec('timeout 15 '.$cmd.' 2>&1; echo __EXIT:$?'));
        if (str_contains($out, 'Permission denied')) return ['ok'=>false,'msg'=>'SSH Permission denied'];
        // extract inner exit
        if (preg_match('/__EXIT:(\d+)/',$out,$m) && (int)$m[1]!==0) return ['ok'=>false,'msg'=>'mkdir failed: '.substr($out,0,300)];
        return ['ok'=>true,'msg'=>'Created '.$path];
    }

    static function mkdirRemote(array $in): array {
        $type=$in['type']??''; $path=trim($in['path']??'');
        if ($path==='') return ['ok'=>false,'msg'=>'Enter a folder name'];
        $rclone=trim((string)shell_exec('which rclone 2>/dev/null'));
        if (!$rclone) return ['ok'=>false,'msg'=>'rclone not found'];
        $host=trim($in['host']??''); $port=trim((string)($in['port']??'')); $user=trim($in['user']??'');
        $pass=$in['password']??null; $sftpAuth=$in['sftpAuth']??'password'; $keyPath=trim($in['keyPath']??'');
        $bucket=trim($in['bucket']??$in['s3Bucket']??''); $region=trim($in['region']??$in['s3Region']??'');
        $endpoint=trim($in['endpoint']??$in['s3Endpoint']??''); $provider=trim($in['provider']??$in['s3Provider']??'AWS');
        $accessKey=trim($in['accessKey']??$in['s3AccessKey']??''); $secretKey=$in['secretKey']??$in['s3SecretKey']??null;

        // Inline rclone backend params (no config file written — works even when
        // /var/www is unwritable by www-data). Uses rclone's :backend: syntax.
        if ($type==='sftp') {
            if ($sftpAuth==='key') {
                if (!$keyPath) return ['ok'=>false,'msg'=>'SSH key path required'];
                $flags=['--sftp-host='.escapeshellarg($host),'--sftp-user='.escapeshellarg($user),'--sftp-port='.escapeshellarg($port?:'22'),'--sftp-key-file='.escapeshellarg($keyPath)];
            } else {
                if ($pass===null||$pass==='') return ['ok'=>false,'msg'=>'Password required'];
                $obscured=trim((string)shell_exec('rclone obscure '.escapeshellarg($pass).' 2>/dev/null'));
                $flags=['--sftp-host='.escapeshellarg($host),'--sftp-user='.escapeshellarg($user),'--sftp-port='.escapeshellarg($port?:'22'),'--sftp-pass='.escapeshellarg($obscured)];
            }
        } elseif ($type==='ftp') {
            if ($pass===null||$pass==='') return ['ok'=>false,'msg'=>'Password required'];
            $obscured=trim((string)shell_exec('rclone obscure '.escapeshellarg($pass).' 2>/dev/null'));
            $flags=['--ftp-host='.escapeshellarg($host),'--ftp-user='.escapeshellarg($user),'--ftp-port='.escapeshellarg($port?:'21'),'--ftp-pass='.escapeshellarg($obscured)];
        } elseif ($type==='s3') {
            if ($accessKey===''||$secretKey===null||$secretKey==='') return ['ok'=>false,'msg'=>'Access key/secret required'];
            $flags=['--s3-provider='.escapeshellarg($provider),'--s3-region='.escapeshellarg($region),'--s3-access-key-id='.escapeshellarg($accessKey),'--s3-secret-access-key='.escapeshellarg($secretKey)];
            if ($endpoint) $flags[]='--s3-endpoint='.escapeshellarg($endpoint);
        } else return ['ok'=>false,'msg'=>'Unknown type'];
        $flagStr=implode(' ',$flags);
        $backend=':'.$type.':';

        if ($type==='s3') {
            // S3 folders are virtual — `rclone mkdir` does nothing on providers that
            // can't hold empty dirs. Upload a zero-byte marker object at the target
            // path so the prefix is visible when browsing.
            $tmpCfg='/tmp/rclone-rw-'.getmypid().'.conf';
            $remotePath=$backend.($bucket?rtrim($bucket,'/').'/' : '').ltrim($path,'/');
            $mkCmd='echo -n "" | timeout 15 rclone rcat --config '.escapeshellarg($tmpCfg).' '.escapeshellarg($remotePath.'/.keep').' '.$flagStr.' 2>&1; echo __EXIT:$?';
            $mkOut=trim((string)shell_exec($mkCmd));
            $code=0; if (preg_match('/__EXIT:(\d+)/',$mkOut,$m)) $code=(int)$m[1];
            if ($code===0) return ['ok'=>true,'msg'=>'Created '.$path];
            return ['ok'=>false,'msg'=>substr($mkOut,0,400)?:'S3 mkdir failed'];
        }

        // sftp / ftp
        $tmpCfg='/tmp/rclone-rw-'.getmypid().'.conf';
        $remotePath=$backend.ltrim($path,'/');
        $mkCmd='timeout 15 rclone mkdir --config '.escapeshellarg($tmpCfg).' '.escapeshellarg($remotePath).' '.$flagStr.' 2>&1; echo __EXIT:$?';
        $out=trim((string)shell_exec($mkCmd));
        $code=0; if (preg_match('/__EXIT:(\d+)/',$out,$m)) $code=(int)$m[1];
        if ($code===0) return ['ok'=>true,'msg'=>'Created '.$path];
        return ['ok'=>false,'msg'=>substr($out,0,400)?:'mkdir failed'];
    }
}
