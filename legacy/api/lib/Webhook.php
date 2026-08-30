<?php
class Webhook {
    static function test(array $body): array {
        $url = $body['url'] ?? '';
        $payload = $body['payload'] ?? null;
        if (!is_string($url) || !preg_match('#^https://(canary\.|ptb\.)?discord(app)?\.com/api/webhooks/#', $url)) {
            return ['code'=>400,'body'=>['error'=>'Invalid Discord webhook URL']];
        }
        $ch = curl_init($url.'?wait=true');
        curl_setopt_array($ch, [
            CURLOPT_POST=>true,
            CURLOPT_POSTFIELDS=>json_encode($payload),
            CURLOPT_HTTPHEADER=>['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER=>true,
            CURLOPT_TIMEOUT=>12,
        ]);
        $resp = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($err) return ['code'=>502,'body'=>['error'=>$err]];
        if ($code >= 400) return ['code'=>$code,'body'=>['error'=>"Discord responded $code",'detail'=>substr((string)$resp,0,300)]];
        return ['code'=>200,'body'=>['ok'=>true]];
    }
}
