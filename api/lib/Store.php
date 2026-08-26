<?php
class Store {
    const DATA_DIR = __DIR__ . '/../../data/scripts';

    static function init(): void { @mkdir(self::DATA_DIR, 0750, true); }

    static function safeId(string $id): bool {
        return (bool)preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/i', $id);
    }

    static function fileFor(string $id): string { return self::DATA_DIR . '/' . $id . '.json'; }

    static function read(string $id): ?array {
        $f = self::fileFor($id);
        if (!file_exists($f)) return null;
        $doc = json_decode((string)file_get_contents($f), true);
        if (!is_array($doc)) return null;
        if (empty($doc['rawToken'])) {
            $doc['rawToken'] = bin2hex(random_bytes(12));
            file_put_contents($f, json_encode($doc, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES), LOCK_EX);
        }
        return $doc;
    }

    static function write(array $doc): array {
        $doc['updatedAt'] = gmdate('c');
        if (empty($doc['rawToken'])) $doc['rawToken'] = bin2hex(random_bytes(12));
        file_put_contents(self::fileFor($doc['id']), json_encode($doc, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES), LOCK_EX);
        return $doc;
    }

    static function list(): array {
        // backfill tokens lazily
        foreach (glob(self::DATA_DIR.'/*.json') ?: [] as $p) {
            $d = json_decode((string)file_get_contents($p), true);
            if (is_array($d) && empty($d['rawToken'])) {
                $d['rawToken'] = bin2hex(random_bytes(12));
                file_put_contents($p, json_encode($d, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES), LOCK_EX);
            }
        }
        $out = [];
        foreach (glob(self::DATA_DIR.'/*.json') ?: [] as $p) {
            $d = json_decode((string)file_get_contents($p), true);
            if (!is_array($d) || empty($d['id'])) continue;
            $out[] = ['id'=>$d['id'],'name'=>$d['name']??$d['id'],'updatedAt'=>$d['updatedAt']??'','rawToken'=>$d['rawToken']??''];
        }
        usort($out, fn($a,$b)=>strcmp($b['updatedAt']??'',$a['updatedAt']??''));
        return $out;
    }

    static function slug(string $name): string {
        $base = strtolower(trim($name) ?: 'untitled');
        $base = preg_replace('/[^a-z0-9]+/','-',$base);
        $base = trim($base,'-');
        $base = substr($base,0,40) ?: 'script';
        $id=$base; $n=1;
        while (file_exists(self::fileFor($id))) $id=$base.'-'.(++$n);
        return $id;
    }
}
