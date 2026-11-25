<?php

declare(strict_types=1);
require __DIR__ . DIRECTORY_SEPARATOR . 'bootstrap.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    $limit = positiveInt((string) ($_GET['limit'] ?? '120'), 120, 500);
    try {
        $query = database()->query(
            'SELECT id, device_id AS zone, temperature, humidity, gas, flame_detected,
                    UNIX_TIMESTAMP(created_at) * 1000 AS timestamp_ms, created_at
             FROM sensor_readings ORDER BY id DESC LIMIT ' . $limit
        );
        $readings = array_reverse($query->fetchAll());
        respondJson(200, ['ok' => true, 'readings' => $readings]);
    } catch (PDOException $error) {
        error_log('SIPATAR readings query failed: ' . $error->getMessage());
        respondJson(500, ['ok' => false, 'error' => 'Data sensor gagal dibaca dari database.']);
    }
}

requireMethod('POST');
$deviceId = deviceIdFromToken();
if ($deviceId !== 'zona1' && $deviceId !== 'zona2') {
    respondJson(403, ['ok' => false, 'error' => 'Perangkat ini tidak diizinkan mengirim data sensor.']);
}
$payload = readJsonBody();

$dhtSkipped = $deviceId === 'zona2' &&
    array_key_exists('temperature', $payload) && $payload['temperature'] === null &&
    array_key_exists('humidity', $payload) && $payload['humidity'] === null;
$temperature = $dhtSkipped ? null : filter_var($payload['temperature'] ?? null, FILTER_VALIDATE_FLOAT);
$humidity = $dhtSkipped ? null : filter_var($payload['humidity'] ?? null, FILTER_VALIDATE_FLOAT);
$gas = filter_var($payload['gas'] ?? null, FILTER_VALIDATE_INT);
$flame = $payload['flameDetected'] ?? null;
$flameValid = is_bool($flame) || $flame === 0 || $flame === 1 || $flame === '0' || $flame === '1';
$dhtValid = $dhtSkipped || (
    $temperature !== false && $temperature >= -40 && $temperature <= 125 &&
    $humidity !== false && $humidity >= 0 && $humidity <= 100
);

if (!$dhtValid || $gas === false || $gas < 0 || $gas > 4095 || !$flameValid) {
    respondJson(400, ['ok' => false, 'error' => 'Nilai suhu, kelembapan, gas, atau flame tidak valid untuk perangkat ini.']);
}

try {
    $statement = database()->prepare(
        'INSERT INTO sensor_readings (device_id, temperature, humidity, gas, flame_detected)
         VALUES (:device_id, :temperature, :humidity, :gas, :flame_detected)'
    );
    $statement->execute([
        'device_id' => $deviceId,
        'temperature' => $temperature,
        'humidity' => $humidity,
        'gas' => $gas,
        'flame_detected' => (int) (bool) $flame,
    ]);
    respondJson(201, ['ok' => true, 'id' => (int) database()->lastInsertId()]);
} catch (PDOException $error) {
    error_log('SIPATAR reading insert failed: ' . $error->getMessage());
    respondJson(500, ['ok' => false, 'error' => 'Data sensor gagal disimpan.']);
}
