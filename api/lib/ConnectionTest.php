<?php
class ConnectionTest {
    // Test a destination (sftp/ftp/s3) by creating an ephemeral rclone remote and doing lsd
    static function testDestination(array $in): array {
        $type = $in['type'] ?? $in['destType'] ?? '';
        $host = trim($in['host'] ?? '');
        $port = trim((string)($in['port'] ?? ''));
        $user = trim($in['user'] ?? '');
        $pass = $in['password'] ?? $in['pass'] ?? null;
        $sftpAuth = $in['sftpAuth'] ?? 'password';
        $keyPath = trim($in['keyPath'] ?? '');
        $bucket = trim($in['bucket'] ?? $in['s3Bucket'] ?? '');
        $region = trim($in['region'] ?? $in['s3Region'] ?? '');
        $endpoint = trim($in['endpoint'] ?? $in['s3Endpoint'] ?? '');
        $provider = trim($in['provider'] ?? $in['s3Provider'] ?? 'AWS');
        $accessKey = trim($in['accessKey'] ?? $in['s3AccessKey'] ?? '');
        $secretKey = $in['secretKey'] ?? $in['s3SecretKey'] ?? null;

        if (!in_array($type, ['sftp','ftp','s3'], true)) return ['ok'=>false,'msg'=>'Unknown type'];
        if ($type !== 's3' && !$host) return ['ok'=>false,'msg'=>'Host is required'];
        if ($type === 's3' && !$bucket && $provider==='AWS') { /* bucket optional for list */ }

        // check rclone exists
        $rclone = trim((string)shell_exec('which rclone 2>/dev/null'));
        if (!$rclone) return ['ok'=>false,'msg'=>'rclone not found on panel server (install: curl https://rclone.org/install.sh | sudo bash)'];

        $remote = '_test_'.bin2hex(random_bytes(4));
        $cmd = '';
        $tmpEnv = [];

        if ($type === 'sftp') {
            if ($sftpAuth === 'key') {
                if (!$keyPath) return ['ok'=>false,'msg'=>'SSH key path required'];
                $cmd = sprintf('rclone config create %s sftp host %s user %s key_file %s --non-interactive 2>&1',
                    escapeshellarg($remote), escapeshellarg($host), escapeshellarg($user), escapeshellarg($keyPath));
            } else {
                if ($pass === null || $pass === '') return ['ok'=>false,'msg'=>'Password required'];
                $obscured = trim((string)shell_exec('rclone obscure '.escapeshellarg($pass).' 2>/dev/null'));
                $cmd = sprintf('rclone config create %s sftp host %s user %s port %s pass %s --non-interactive 2>&1',
                    escapeshellarg($remote), escapeshellarg($host), escapeshellarg($user), escapeshellarg($port ?: '22'), escapeshellarg($obscured));
            }
        } elseif ($type === 'ftp') {
            if ($pass === null || $pass === '') return ['ok'=>false,'msg'=>'Password required'];
            $obscured = trim((string)shell_exec('rclone obscure '.escapeshellarg($pass).' 2>/dev/null'));
            $cmd = sprintf('rclone config create %s ftp host %s user %s port %s pass %s --non-interactive 2>&1',
                escapeshellarg($remote), escapeshellarg($host), escapeshellarg($user), escapeshellarg($port ?: '21'), escapeshellarg($obscured));
        } else { // s3
            if ($accessKey === '' || $secretKey === null || $secretKey === '') return ['ok'=>false,'msg'=>'Access key and secret required'];
            // rclone config create expects raw secret (it obscures internally); passing already-obscured causes double-obscure and SignatureDoesNotMatch
            $cmd = sprintf('rclone config create %s s3 provider %s region %s access_key_id %s secret_access_key %s --non-interactive',
                escapeshellarg($remote), escapeshellarg($provider), escapeshellarg($region), escapeshellarg($accessKey), escapeshellarg($secretKey));
            if ($endpoint) $cmd .= ' endpoint '.escapeshellarg($endpoint);
            // Avoid 409 BucketAlreadyExists on existing buckets (Minio etc.)
            $cmd .= ' no_check_bucket true';
            $cmd .= ' 2>&1';
        }

        @shell_exec($cmd);
        // probe: for S3 with bucket, test the bucket directly to avoid ListBuckets permission issues and Signature region mismatches on account level
        if ($type === 's3' && $bucket !== '') {
            $probe = 'timeout 12 rclone lsd '.escapeshellarg($remote.':'.$bucket).' --max-depth 1 2>&1; echo __EXIT:$?';
        } else {
            $probe = 'timeout 12 rclone lsd '.escapeshellarg($remote.':').' --max-depth 1 2>&1; echo __EXIT:$?';
        }
        $out = (string)shell_exec($probe);
        // cleanup
        @shell_exec('rclone config delete '.escapeshellarg($remote).' 2>&1');

        $code = 0;
        if (preg_match('/__EXIT:(\d+)/',$out,$m)) { $code=(int)$m[1]; $out=str_replace($m[0],'',$out); }
        $out=trim($out);
        if ($code===0) return ['ok'=>true,'msg'=>'Connection OK'.($out ? " — ".substr($out,0,200) : '')];
        // humanize common errors
        $lower=strtolower($out);
        if (str_contains($lower,'signaturedoesnotmatch')) $out='S3 signature mismatch — check: 1) Region matches endpoint (e.g. us-east-1 for AWS, correct for Wasabi/Minio), 2) Endpoint URL is exact (https://... with no trailing slash), 3) System clock is correct (NTP), 4) Access/Secret key correct. Raw: '.substr($out,0,250);
        elseif (str_contains($lower,'auth')||str_contains($lower,'password')||str_contains($lower,'login')) $out='Authentication failed — check user/password';
        elseif (str_contains($lower,'timeout')||str_contains($lower,'refused')||str_contains($lower,'no route')) $out='Cannot reach host — check host/port/firewall';
        elseif (str_contains($lower,'no such host')||str_contains($lower,'could not resolve')) $out='DNS lookup failed';
        elseif (str_contains($lower,'403')||str_contains($lower,'accessdenied')) $out='S3 access denied — check bucket name, region, and IAM permissions (needs ListBuckets or bucket access)';
        return ['ok'=>false,'msg'=>substr($out,0,500) ?: 'Connection failed'];
    }

    static function testSource(string $vpsId): array {
        $vps = Fleet::readDecrypted($vpsId);
        if (!$vps) return ['ok'=>false,'msg'=>'VPS not found'];
        $sshBase = Runs::buildSshBase($vps);
        // Runs::buildSshBase currently returns a string including host; rebuild for test
        $host=$vps['host']; $user=$vps['user']; $port=(int)($vps['port']??22);
        $hasSshpass = !empty($vps['password']) && trim((string)shell_exec('which sshpass 2>/dev/null'));
        $usePass = $hasSshpass && ($vps['auth']??'password')==='password';
        $batchMode = $usePass ? 'no' : 'yes';
        $pref = $usePass ? 'password,keyboard-interactive' : 'publickey';
        $keyOpt = ($vps['auth']??'password')==='key' && !empty($vps['keyPath']) ? ' -i '.escapeshellarg($vps['keyPath']) : '';
        $cmd = "ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=$batchMode -o PreferredAuthentications=$pref -p $port$keyOpt $user@$host 'echo ok; which rclone; echo RCLONE:\$?; which curl; echo CURL:\$?; which bash; echo BASH:\$?; rclone version 2>&1 | head -1' 2>&1";
        if ($usePass) {
            $cmd = 'sshpass -p '.escapeshellarg($vps['password']).' '.$cmd;
        }
        $out = trim((string)shell_exec('timeout 15 '.$cmd.' 2>&1; echo __EXIT:$?'));
        $code=0; if (preg_match('/__EXIT:(\d+)/',$out,$m)) { $code=(int)$m[1]; $out=str_replace($m[0],'',$out); }
        $out=trim($out);
        if ($code===0 && str_contains($out,'ok')) {
            Fleet::touchSeen($vpsId);
            $hasRclone = str_contains($out,'rclone');
            // package checks
            $checks = [];
            $checks['rclone'] = str_contains($out, 'RCLONE:0') || str_contains($out, '/rclone');
            $checks['curl'] = str_contains($out, 'CURL:0') || str_contains($out, '/curl');
            $checks['bash'] = str_contains($out, 'BASH:0');
            $missing = [];
            if (!$checks['rclone']) $missing[] = 'rclone (install: curl https://rclone.org/install.sh | sudo bash)';
            if (!$checks['curl']) $missing[] = 'curl (apt install curl)';
            if ($missing) {
                return ['ok'=>true,'msg'=>'SSH OK, but missing: '.implode(', ', $missing).' — install on source VPS. Raw: '.substr($out,0,200), 'checks'=>$checks, 'missing'=>$missing];
            }
            return ['ok'=>true,'msg'=>$hasRclone ? 'SSH OK, rclone found' : 'SSH OK, rclone found', 'checks'=>$checks];
        }
        $lower=strtolower($out);
        if (str_contains($lower,'permission denied')) {
            return ['ok'=>false,'msg'=>'Permission denied — check: 1) password correct, 2) server allows PasswordAuthentication yes, 3) PermitRootLogin yes (or use non-root user), 4) try SSH key auth instead. Raw: '.substr($out,0,250)];
        }
        return ['ok'=>false,'msg'=>substr($out,0,400) ?: 'SSH connection failed'];
    }
}
