<?php
class Fleet {
    const DIR = __DIR__ . '/../../data/fleet';
    const ENC_KEY_BYTES = 32; // sodium secretbox key

    static function init(): void { @mkdir(self::DIR, 0750, true); }

    static function encKey(): string {
        // derive 32-byte key from SECRET file via hkdf-like hash
        $secret = Auth::secret();
        return substr(hash('sha256', 'fleet-enc:'.$secret, true), 0, 32);
    }

    static function encrypt(?string $plain): ?string {
        if ($plain === null || $plain === '') return null;
        $key = self::encKey();
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $ct = sodium_crypto_secretbox($plain, $nonce, $key);
        return base64_encode($nonce.$ct);
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

    static function safeId(string $id): bool { return (bool)preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/i',$id); }

    static function fileFor(string $id): string { return self::DIR.'/vps-'.$id.'.json'; }

    static function list(): array {
        $out=[];
        foreach (glob(self::DIR.'/vps-*.json')?:[] as $p) {
            $d=json_decode((string)file_get_contents($p), true);
            if (!is_array($d)) continue;
            // never expose encrypted password
            $out[] = [
                'id'=>$d['id'],'name'=>$d['name'],'host'=>$d['host'],'port'=>$d['port']??22,
                'user'=>$d['user'],'auth'=>$d['auth']??'password','hasPassword'=>!empty($d['passwordEnc']),
                'createdAt'=>$d['createdAt']??'','lastSeen'=>$d['lastSeen']??null,
            ];
        }
        usort($out, fn($a,$b)=>strcmp($a['name'],$b['name']));
        return $out;
    }

    static function read(string $id): ?array {
        $f=self::fileFor($id);
        if (!file_exists($f)) return null;
        $d=json_decode((string)file_get_contents($f), true);
        return is_array($d)?$d:null;
    }

    // returns doc with decrypted password for internal use (caller must not expose)
    static function readDecrypted(string $id): ?array {
        $d=self::read($id);
        if (!$d) return null;
        $d['password'] = self::decrypt($d['passwordEnc'] ?? null);
        return $d;
    }

    static function isValidHost(string $host): bool {
        if ($host === '') return false;
        // allow IP or hostname (letters, digits, dot, hyphen), no shell metachars, no spaces, no ; & | $ ` etc.
        if (!preg_match('/^[a-zA-Z0-9.\-]+$/', $host)) return false;
        // also validate via filter_var for IP or hostname
        if (filter_var($host, FILTER_VALIDATE_IP)) return true;
        if (filter_var($host, FILTER_VALIDATE_DOMAIN, FILTER_FLAG_HOSTNAME)) return true;
        return false;
    }
    static function isValidUser(string $user): bool {
        return (bool)preg_match('/^[a-zA-Z0-9._\-@]+$/', $user);
    }
    static function create(array $in): array {
        $host=trim($in['host']??'');
        $user=trim($in['user']??'root');
        if (!self::isValidHost($host)) throw new InvalidArgumentException('Invalid host');
        if (!self::isValidUser($user)) throw new InvalidArgumentException('Invalid user');
        $id = preg_replace('/[^a-z0-9]+/','-', strtolower(trim($in['name']??'vps')));
        $id = trim($id,'-') ?: 'vps';
        $id = substr($id,0,30);
        $base=$id; $n=1;
        while (file_exists(self::fileFor($base.($n>1?"-$n":'')))) $n++;
        if ($n>1) $id="$base-$n"; else $id=$base;
        $doc=[
            'id'=>$id,
            'name'=>trim($in['name']??$id),
            'host'=>$host,
            'port'=>(int)($in['port']??22),
            'user'=>$user,
            'auth'=>($in['auth']??'password')==='key'?'key':'password',
            'passwordEnc'=>isset($in['password']) && $in['password']!=='' ? self::encrypt($in['password']) : null,
            'keyPath'=>trim($in['keyPath']??''),
            'createdAt'=>gmdate('c'),
            'updatedAt'=>gmdate('c'),
            'lastSeen'=>null,
        ];
        file_put_contents(self::fileFor($id), json_encode($doc, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES), LOCK_EX);
        return $doc;
    }

    static function update(string $id, array $in): ?array {
        $doc=self::read($id);
        if (!$doc) return null;
        if (isset($in['name'])) $doc['name']=trim($in['name']);
        if (isset($in['host'])) {
            $h=trim($in['host']);
            if (!self::isValidHost($h)) throw new InvalidArgumentException('Invalid host');
            $doc['host']=$h;
        }
        if (isset($in['port'])) $doc['port']=(int)$in['port'];
        if (isset($in['user'])) {
            $u=trim($in['user']);
            if (!self::isValidUser($u)) throw new InvalidArgumentException('Invalid user');
            $doc['user']=$u;
        }
        if (isset($in['auth'])) $doc['auth']=$in['auth']==='key'?'key':'password';
        if (array_key_exists('password',$in) && $in['password'] !== '') {
            $doc['passwordEnc'] = self::encrypt($in['password']);
        }
        // if password key exists but empty, keep existing passwordEnc (don't clear)
        if (isset($in['keyPath'])) $doc['keyPath']=trim($in['keyPath']);
        $doc['updatedAt']=gmdate('c');
        file_put_contents(self::fileFor($id), json_encode($doc, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES), LOCK_EX);
        return $doc;
    }

    static function delete(string $id): void {
        @unlink(self::fileFor($id));
        // also remove related schedules/runs
        foreach (glob(__DIR__.'/../../data/schedules/*.json')?:[] as $p) {
            $d=json_decode((string)file_get_contents($p),true);
            if (($d['vpsId']??'')===$id) @unlink($p);
        }
        foreach (glob(__DIR__.'/../../data/runs/*__'.$id.'.json')?:[] as $p) @unlink($p);
        foreach (glob(__DIR__.'/../../data/runs/'.$id.'__*.json')?:[] as $p) @unlink($p);
    }

    static function touchSeen(string $id): void {
        $d=self::read($id);
        if (!$d) return;
        $d['lastSeen']=gmdate('c');
        file_put_contents(self::fileFor($id), json_encode($d, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES), LOCK_EX);
    }
}
