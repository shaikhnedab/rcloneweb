<?php
class Destinations {
    const DIR = __DIR__ . '/../../data/destinations';

    static function init(): void { @mkdir(self::DIR, 0750, true); }

    static function encKey(): string {
        $secret = Auth::secret();
        return substr(hash('sha256', 'dest-enc:'.$secret, true), 0, 32);
    }

    static function encrypt(?string $plain): ?string {
        if ($plain === null || $plain === '') return null;
        $key = self::encKey();
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        return base64_encode($nonce . sodium_crypto_secretbox($plain, $nonce, $key));
    }

    static function decrypt(?string $enc): ?string {
        if (!$enc) return null;
        $key = self::encKey();
        $raw = base64_decode($enc, true);
        if ($raw === false || strlen($raw) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES) return null;
        $nonce = substr($raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $ct = substr($raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $pt = sodium_crypto_secretbox_open($ct, $nonce, $key);
        return $pt === false ? null : $pt;
    }

    static function safeId(string $id): bool { return (bool)preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/i', $id); }
    static function fileFor(string $id): string { return self::DIR . '/dest-'.$id.'.json'; }
    static function isValidHost(string $host): bool {
        if ($host === '') return false;
        if (!preg_match('/^[a-zA-Z0-9.\-]+$/', $host)) return false;
        if (filter_var($host, FILTER_VALIDATE_IP)) return true;
        if (filter_var($host, FILTER_VALIDATE_DOMAIN, FILTER_FLAG_HOSTNAME)) return true;
        return false;
    }
    static function isValidUser(string $user): bool { return (bool)preg_match('/^[a-zA-Z0-9._\-@]+$/', $user); }

    static function list(): array {
        $out = [];
        foreach (glob(self::DIR.'/dest-*.json') ?: [] as $p) {
            $d = json_decode((string)file_get_contents($p), true);
            if (!is_array($d)) continue;
            $out[] = [
                'id'=>$d['id'],'name'=>$d['name'],'type'=>$d['type']??'sftp',
                'host'=>$d['host']??'','port'=>$d['port']??'','user'=>$d['user']??'',
                'remoteName'=>$d['remoteName']??'','remotePath'=>$d['remotePath']??'',
                'sftpAuth'=>$d['sftpAuth']??'password','hasPassword'=>!empty($d['passwordEnc']),
                'hasSecret'=>!empty($d['s3SecretEnc']),'s3Provider'=>$d['s3Provider']??'AWS',
                's3Bucket'=>$d['s3Bucket']??'','s3Region'=>$d['s3Region']??'',
                's3Endpoint'=>$d['s3Endpoint']??'','createdAt'=>$d['createdAt']??'','lastSeen'=>$d['lastSeen']??null,
            ];
        }
        usort($out, fn($a,$b)=>strcmp($a['name'],$b['name']));
        return $out;
    }

    static function read(string $id): ?array {
        $f = self::fileFor($id);
        if (!file_exists($f)) return null;
        $d = json_decode((string)file_get_contents($f), true);
        return is_array($d) ? $d : null;
    }

    static function readDecrypted(string $id): ?array {
        $d = self::read($id);
        if (!$d) return null;
        $d['password'] = self::decrypt($d['passwordEnc'] ?? null);
        $d['s3AccessKey'] = self::decrypt($d['s3AccessEnc'] ?? null) ?? ($d['s3AccessKey'] ?? '');
        // legacy fallback for older key name
        if (empty($d['s3AccessKey']) && isset($d['s3AccessKeyEnc'])) $d['s3AccessKey'] = self::decrypt($d['s3AccessKeyEnc'] ?? null) ?? $d['s3AccessKey'];
        $d['s3SecretKey'] = self::decrypt($d['s3SecretEnc'] ?? null);
        return $d;
    }

    static function create(array $in): array {
        $type=in_array($in['type']??'sftp',['sftp','ftp','s3'])?$in['type']:'sftp';
        $host=trim($in['host']??'');
        $user=trim($in['user']??'');
        if ($type!=='s3' && $host!=='' && !self::isValidHost($host)) throw new InvalidArgumentException('Invalid host');
        if ($type!=='s3' && $user!=='' && !self::isValidUser($user)) throw new InvalidArgumentException('Invalid user');
        $id = preg_replace('/[^a-z0-9]+/','-', strtolower(trim($in['name']??'dest')));
        $id = trim($id,'-') ?: 'dest';
        $id = substr($id,0,30);
        $base=$id; $n=1;
        while (file_exists(self::fileFor($base.($n>1?"-$n":'')))) $n++;
        if ($n>1) $id="$base-$n"; else $id=$base;
        $doc = [
            'id'=>$id,
            'name'=>trim($in['name']??$id),
            'type'=>$type,
            'host'=>$host,
            'port'=>trim((string)($in['port']??'')),
            'user'=>$user,
            'remoteName'=>trim($in['remoteName']??'my-backup-remote'),
            'remotePath'=>trim($in['remotePath']??'/'),
            'sftpAuth'=>($in['sftpAuth']??'password')==='key'?'key':'password',
            'keyPath'=>trim($in['keyPath']??''),
            's3Provider'=>trim($in['s3Provider']??'AWS'),
            's3Bucket'=>trim($in['s3Bucket']??''),
            's3Region'=>trim($in['s3Region']??''),
            's3Endpoint'=>trim($in['s3Endpoint']??''),
            'passwordEnc'=>isset($in['password']) && $in['password']!=='' ? self::encrypt($in['password']) : null,
            's3AccessEnc'=>isset($in['s3AccessKey']) && $in['s3AccessKey']!=='' ? self::encrypt($in['s3AccessKey']) : null,
            's3SecretEnc'=>isset($in['s3SecretKey']) && $in['s3SecretKey']!=='' ? self::encrypt($in['s3SecretKey']) : null,
            // keep plain for display if needed (not saved)
            'createdAt'=>gmdate('c'),'updatedAt'=>gmdate('c'),'lastSeen'=>null,
        ];
        file_put_contents(self::fileFor($id), json_encode($doc, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES), LOCK_EX);
        return $doc;
    }

    static function update(string $id, array $in): ?array {
        $doc=self::read($id);
        if (!$doc) return null;
        if (isset($in['host'])) {
            $h=trim((string)$in['host']);
            if ($h!=='' && !self::isValidHost($h)) throw new InvalidArgumentException('Invalid host');
        }
        if (isset($in['user'])) {
            $u=trim((string)$in['user']);
            if ($u!=='' && !self::isValidUser($u)) throw new InvalidArgumentException('Invalid user');
        }
        foreach (['name','type','host','port','user','remoteName','remotePath','sftpAuth','keyPath','s3Provider','s3Bucket','s3Region','s3Endpoint'] as $k) {
            if (isset($in[$k])) $doc[$k]=trim((string)$in[$k]);
        }
        if (array_key_exists('password',$in) && $in['password']!=='') $doc['passwordEnc']=self::encrypt($in['password']);
        if (array_key_exists('s3AccessKey',$in) && $in['s3AccessKey']!=='') $doc['s3AccessEnc']=self::encrypt($in['s3AccessKey']);
        if (array_key_exists('s3SecretKey',$in) && $in['s3SecretKey']!=='') $doc['s3SecretEnc']=self::encrypt($in['s3SecretKey']);
        $doc['updatedAt']=gmdate('c');
        file_put_contents(self::fileFor($id), json_encode($doc, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES), LOCK_EX);
        return $doc;
    }

    static function delete(string $id): void { @unlink(self::fileFor($id)); }

    static function touchSeen(string $id): void {
        $d=self::read($id);
        if (!$d) return;
        $d['lastSeen']=gmdate('c');
        file_put_contents(self::fileFor($id), json_encode($d, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES), LOCK_EX);
    }
}
