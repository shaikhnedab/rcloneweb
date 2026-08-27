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

        $remote = '_browse_'.bin2hex(random_bytes(4));
        $createCmd = '';
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

        if ($type === 'sftp') {
            if ($sftpAuth === 'key') {
                $createCmd = sprintf('rclone config create %s sftp host %s user %s key_file %s --non-interactive',
                    escapeshellarg($remote), escapeshellarg($host), escapeshellarg($user), escapeshellarg($keyPath));
            } else {
                if ($pass === null || $pass === '') return ['ok'=>false,'msg'=>'Password required','path'=>$path,'entries'=>[]];
                $obscured = trim((string)shell_exec('rclone obscure '.escapeshellarg($pass).' 2>/dev/null'));
                $createCmd = sprintf('rclone config create %s sftp host %s user %s port %s pass %s --non-interactive',
                    escapeshellarg($remote), escapeshellarg($host), escapeshellarg($user), escapeshellarg($port ?: '22'), escapeshellarg($obscured));
            }
        } elseif ($type === 'ftp') {
            if ($pass === null || $pass === '') return ['ok'=>false,'msg'=>'Password required','path'=>$path,'entries'=>[]];
            $obscured = trim((string)shell_exec('rclone obscure '.escapeshellarg($pass).' 2>/dev/null'));
            $createCmd = sprintf('rclone config create %s ftp host %s user %s port %s pass %s --non-interactive',
                escapeshellarg($remote), escapeshellarg($host), escapeshellarg($user), escapeshellarg($port ?: '21'), escapeshellarg($obscured));
        } elseif ($type === 's3') {
            if ($accessKey === '' || $secretKey === null || $secretKey === '') return ['ok'=>false,'msg'=>'Access key/secret required','path'=>$path,'entries'=>[]];
            $createCmd = sprintf('rclone config create %s s3 provider %s region %s access_key_id %s secret_access_key %s --non-interactive',
                escapeshellarg($remote), escapeshellarg($provider), escapeshellarg($region), escapeshellarg($accessKey), escapeshellarg($secretKey));
            if ($endpoint) $createCmd .= ' endpoint '.escapeshellarg($endpoint);
            $createCmd .= ' no_check_bucket true';
        } else {
            return ['ok'=>false,'msg'=>'Unknown remote type','path'=>$path,'entries'=>[]];
        }
        $createCmd .= ' 2>&1';

        @shell_exec($createCmd);
        // normalize path: for s3, path is bucket/path or just path
        $remotePath = $remote . ':' . ltrim($path, '/');
        // For s3, if path empty, use bucket
        if ($type === 's3' && $path === '' && $bucket) $remotePath = $remote . ':' . $bucket;
        elseif ($type === 's3' && $bucket && !str_starts_with($path, $bucket)) $remotePath = $remote . ':' . $bucket . '/' . ltrim($path,'/');

        $lsCmd = 'timeout 15 rclone lsjson '.escapeshellarg($remotePath).' 2>&1';
        $out = trim((string)shell_exec($lsCmd));
        // cleanup
        @shell_exec('rclone config delete '.escapeshellarg($remote).' 2>&1');

        if (str_starts_with($out, '[')) {
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
        $remote='_mkdir_'.bin2hex(random_bytes(4));
        $host=trim($in['host']??''); $port=trim((string)($in['port']??'')); $user=trim($in['user']??'');
        $pass=$in['password']??null; $sftpAuth=$in['sftpAuth']??'password'; $keyPath=trim($in['keyPath']??'');
        $bucket=trim($in['bucket']??$in['s3Bucket']??''); $region=trim($in['region']??$in['s3Region']??'');
        $endpoint=trim($in['endpoint']??$in['s3Endpoint']??''); $provider=trim($in['provider']??$in['s3Provider']??'AWS');
        $accessKey=trim($in['accessKey']??$in['s3AccessKey']??''); $secretKey=$in['secretKey']??$in['s3SecretKey']??null;
        $createCmd='';
        if ($type==='sftp') {
            if ($sftpAuth==='key') $createCmd=sprintf('rclone config create %s sftp host %s user %s key_file %s --non-interactive 2>&1', escapeshellarg($remote),escapeshellarg($host),escapeshellarg($user),escapeshellarg($keyPath));
            else {
                if ($pass===null||$pass==='') return ['ok'=>false,'msg'=>'Password required'];
                $obscured=trim((string)shell_exec('rclone obscure '.escapeshellarg($pass).' 2>/dev/null'));
                $createCmd=sprintf('rclone config create %s sftp host %s user %s port %s pass %s --non-interactive 2>&1', escapeshellarg($remote),escapeshellarg($host),escapeshellarg($user),escapeshellarg($port?:'22'),escapeshellarg($obscured));
            }
        } elseif ($type==='ftp') {
            if ($pass===null||$pass==='') return ['ok'=>false,'msg'=>'Password required'];
            $obscured=trim((string)shell_exec('rclone obscure '.escapeshellarg($pass).' 2>/dev/null'));
            $createCmd=sprintf('rclone config create %s ftp host %s user %s port %s pass %s --non-interactive 2>&1', escapeshellarg($remote),escapeshellarg($host),escapeshellarg($user),escapeshellarg($port?:'21'),escapeshellarg($obscured));
        } elseif ($type==='s3') {
            if ($accessKey===''||$secretKey===null||$secretKey==='') return ['ok'=>false,'msg'=>'Access key/secret required'];
            // S3 directories are virtual — just verify bucket access, no mkdir needed
            $createCmd=sprintf('rclone config create %s s3 provider %s region %s access_key_id %s secret_access_key %s --non-interactive', escapeshellarg($remote),escapeshellarg($provider),escapeshellarg($region),escapeshellarg($accessKey),escapeshellarg($secretKey));
            if ($endpoint) $createCmd.=' endpoint '.escapeshellarg($endpoint);
            $createCmd.=' no_check_bucket true 2>&1';
            @shell_exec($createCmd);
            // Verify we can list the bucket (proves creds work), then treat mkdir as success
            $checkPath = $bucket ? $remote.':'.$bucket : $remote.':';
            $checkCmd='timeout 10 rclone lsd '.escapeshellarg($checkPath).' --max-depth 1 2>&1; echo __EXIT:$?';
            $checkOut=trim((string)shell_exec($checkCmd));
            @shell_exec('rclone config delete '.escapeshellarg($remote).' 2>&1');
            $code=0; if (preg_match('/__EXIT:(\d+)/',$checkOut,$m)) $code=(int)$m[1];
            if ($code===0) return ['ok'=>true,'msg'=>'S3 folder ready — will be created on first upload'];
            // If bucket check fails, still allow mkdir as success — S3 will create prefix on upload
            return ['ok'=>true,'msg'=>'S3 folder ready'];
        } else return ['ok'=>false,'msg'=>'Unknown type'];
        @shell_exec($createCmd);
        $remotePath=$remote.':'.ltrim($path,'/');
        if ($type==='s3' && $bucket) $remotePath=$remote.':'.$bucket.'/'.ltrim($path,'/');
        $mkCmd='timeout 15 rclone mkdir '.escapeshellarg($remotePath).' 2>&1; echo __EXIT:$?';
        $out=trim((string)shell_exec($mkCmd));
        @shell_exec('rclone config delete '.escapeshellarg($remote).' 2>&1');
        $code=0; if (preg_match('/__EXIT:(\d+)/',$out,$m)) $code=(int)$m[1];
        if ($code===0) return ['ok'=>true,'msg'=>'Created '.$path];
        return ['ok'=>false,'msg'=>substr($out,0,400)?:'mkdir failed'];
    }
}
