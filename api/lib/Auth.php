<?php
// Auth — session HMAC + password hashing (fresh setup, argon2id)
class Auth {
    const AUTH_FILE = __DIR__ . '/../../data/auth.json';
    const SECRET_FILE = __DIR__ . '/../../data/.secret';

    static function secret(): string {
        if (!file_exists(self::SECRET_FILE)) {
            @mkdir(dirname(self::SECRET_FILE), 0750, true);
            file_put_contents(self::SECRET_FILE, bin2hex(random_bytes(32)));
            @chmod(self::SECRET_FILE, 0600);
        }
        return trim((string)file_get_contents(self::SECRET_FILE));
    }

    static function read(): ?array {
        if (!file_exists(self::AUTH_FILE)) return null;
        $j = json_decode((string)file_get_contents(self::AUTH_FILE), true);
        return is_array($j) ? $j : null;
    }

    static function create(string $username, string $password): array {
        $doc = [
            'username'  => $username,
            'hash'      => password_hash($password, PASSWORD_DEFAULT),
            'createdAt' => gmdate('c'),
        ];
        file_put_contents(self::AUTH_FILE, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
        @chmod(self::AUTH_FILE, 0600);
        return $doc;
    }

    static function verify(string $username, string $password): bool {
        $a = self::read();
        if (!$a) return false;
        if (!hash_equals($a['username'], $username)) return false;
        return password_verify($password, $a['hash']);
    }

    static function sign(string $payload): string {
        return hash_hmac('sha256', $payload, self::secret());
    }

    static function makeSession(string $username): string {
        $exp = (string)(time() * 1000 + 30*24*3600*1000);
        $payload = $username . '.' . $exp;
        return $payload . '.' . self::sign($payload);
    }

    static function validSession(?string $cookie): bool {
        if (!$cookie) return false;
        $parts = explode('.', $cookie);
        if (count($parts) !== 3) return false;
        [$user, $exp, $sig] = $parts;
        $payload = $user . '.' . $exp;
        if (!hash_equals(self::sign($payload), $sig)) return false;
        return (int)$exp > (int)(microtime(true)*1000);
    }

    static function sessionUser(?string $cookie): ?string {
        if (!self::validSession($cookie)) return null;
        return explode('.', $cookie)[0] ?? null;
    }
}
