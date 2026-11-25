<?php

declare(strict_types=1);

function respondJson(int $status, array $body): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

function requireMethod(string $method): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== $method) {
        header('Allow: ' . $method);
        respondJson(405, ['ok' => false, 'error' => 'Metode tidak diizinkan.']);
    }
}

function appConfig(): array
{
    static $config;
    if ($config !== null) {
        return $config;
    }

    $configPath = __DIR__ . DIRECTORY_SEPARATOR . 'config.local.php';
    if (!is_file($configPath)) {
        respondJson(503, [
            'ok' => false,
            'error' => 'Konfigurasi Laragon belum dibuat. Salin api/config.example.php menjadi api/config.local.php.',
        ]);
    }

    $config = require $configPath;
    if (!is_array($config) || !isset($config['db'], $config['device_tokens'])) {
        respondJson(503, ['ok' => false, 'error' => 'Konfigurasi API Laragon tidak valid.']);
    }
    return $config;
}

function database(): PDO
{
    static $pdo;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $db = appConfig()['db'];
    try {
        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
            $db['host'],
            (int) $db['port'],
            $db['database']
        );
        $pdo = new PDO($dsn, $db['username'], $db['password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        return $pdo;
    } catch (PDOException $error) {
        error_log('SIPATAR database connection failed: ' . $error->getMessage());
        respondJson(503, ['ok' => false, 'error' => 'Database Laragon tidak dapat dihubungi. Periksa MySQL dan api/config.local.php.']);
    }
}

function deviceIdFromToken(): string
{
    $headers = function_exists('getallheaders') ? getallheaders() : [];
    $token = $headers['X-Device-Token'] ?? $headers['x-device-token'] ?? $_SERVER['HTTP_X_DEVICE_TOKEN'] ?? '';
    $tokens = appConfig()['device_tokens'];
    foreach ($tokens as $deviceId => $configuredToken) {
        if (is_string($configuredToken) && $configuredToken !== '' &&
            strpos($configuredToken, 'GANTI_TOKEN_') !== 0 &&
            is_string($token) && hash_equals($configuredToken, $token)) {
            return (string) $deviceId;
        }
    }
    respondJson(401, ['ok' => false, 'error' => 'Token perangkat tidak valid atau belum dikonfigurasi.']);
}

function readJsonBody(int $maxBytes = 4096): array
{
    $length = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($length > $maxBytes) {
        respondJson(413, ['ok' => false, 'error' => 'Ukuran permintaan terlalu besar.']);
    }

    $raw = file_get_contents('php://input', false, null, 0, $maxBytes + 1);
    if ($raw === false || strlen($raw) > $maxBytes) {
        respondJson(413, ['ok' => false, 'error' => 'Ukuran permintaan terlalu besar.']);
    }
    $payload = json_decode($raw, true);
    if (!is_array($payload)) {
        respondJson(400, ['ok' => false, 'error' => 'Format JSON tidak valid.']);
    }
    return $payload;
}

function positiveInt(string $value, int $default, int $maximum): int
{
    $parsed = filter_var($value, FILTER_VALIDATE_INT);
    return $parsed === false ? $default : max(1, min($maximum, (int) $parsed));
}
