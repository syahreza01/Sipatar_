<?php

declare(strict_types=1);
require __DIR__ . DIRECTORY_SEPARATOR . 'bootstrap.php';

requireMethod('POST');
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '') {
    $originHost = parse_url($origin, PHP_URL_HOST);
    $requestHost = explode(':', $_SERVER['HTTP_HOST'] ?? '', 2)[0];
    if (!is_string($originHost) || !hash_equals($requestHost, $originHost)) {
        respondJson(403, ['ok' => false, 'error' => 'Permintaan harus berasal dari dashboard ini.']);
    }
}

$payload = readJsonBody();
$token = is_string($payload['token'] ?? null) ? trim($payload['token']) : '';
$chatId = is_string($payload['chatId'] ?? null) ? trim($payload['chatId']) : '';
if (!preg_match('/^\d+:[A-Za-z0-9_-]{20,}$/', $token)) {
    respondJson(400, ['ok' => false, 'error' => 'Format Bot token tidak valid.']);
}
if ($chatId === '' || strlen($chatId) > 128) {
    respondJson(400, ['ok' => false, 'error' => 'Chat ID atau username kanal tidak valid.']);
}
if (!function_exists('curl_init')) {
    respondJson(503, ['ok' => false, 'error' => 'Ekstensi PHP cURL belum aktif di Laragon.']);
}

$curl = curl_init('https://api.telegram.org/bot' . $token . '/sendMessage');
curl_setopt_array($curl, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => http_build_query([
        'chat_id' => $chatId,
        'text' => '[SIPATAR] Pesan uji berhasil. Koneksi bot dan Chat ID aktif.',
    ]),
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
]);
$body = curl_exec($curl);
$curlError = curl_error($curl);
$status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
curl_close($curl);

if (!is_string($body)) {
    error_log('SIPATAR Telegram request failed: ' . $curlError);
    respondJson(502, ['ok' => false, 'error' => 'Tidak dapat terhubung ke Telegram.']);
}
$result = json_decode($body, true);
if ($status < 200 || $status >= 300 || !is_array($result) || empty($result['ok'])) {
    respondJson(502, [
        'ok' => false,
        'error' => is_array($result) && isset($result['description'])
            ? $result['description']
            : 'Telegram menolak pesan uji.',
    ]);
}
respondJson(200, ['ok' => true]);
