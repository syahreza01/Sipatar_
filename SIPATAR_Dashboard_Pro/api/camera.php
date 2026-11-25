<?php

declare(strict_types=1);
require __DIR__ . DIRECTORY_SEPARATOR . 'bootstrap.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    try {
        $pdo = database();
        $snapshotId = filter_var($_GET['id'] ?? null, FILTER_VALIDATE_INT);
        if ($snapshotId !== false && $snapshotId !== null) {
            $statement = $pdo->prepare('SELECT filename FROM camera_snapshots WHERE id = :id');
            $statement->execute(['id' => $snapshotId]);
            $snapshot = $statement->fetch();
            if (!$snapshot) {
                respondJson(404, ['ok' => false, 'error' => 'Snapshot tidak ditemukan.']);
            }
            $file = rtrim(appConfig()['camera_storage_dir'], DIRECTORY_SEPARATOR) .
                DIRECTORY_SEPARATOR . basename($snapshot['filename']);
            if (!is_file($file)) {
                respondJson(404, ['ok' => false, 'error' => 'File snapshot tidak ditemukan.']);
            }
            header('Content-Type: image/jpeg');
            header('Cache-Control: private, max-age=60');
            header('X-Content-Type-Options: nosniff');
            header('Content-Length: ' . filesize($file));
            readfile($file);
            exit;
        }

        $limit = positiveInt((string) ($_GET['limit'] ?? '6'), 6, 50);
        $query = $pdo->query(
            'SELECT id, created_at FROM camera_snapshots ORDER BY id DESC LIMIT ' . $limit
        );
        respondJson(200, ['ok' => true, 'snapshots' => $query->fetchAll()]);
    } catch (PDOException $error) {
        error_log('SIPATAR camera query failed: ' . $error->getMessage());
        respondJson(500, ['ok' => false, 'error' => 'Snapshot gagal dibaca dari database.']);
    }
}

requireMethod('POST');
if (deviceIdFromToken() !== 'esp32cam') {
    respondJson(403, ['ok' => false, 'error' => 'Hanya ESP32-CAM yang dapat mengunggah snapshot.']);
}
$pdo = database();

$contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($contentLength < 4 || $contentLength > 1048576) {
    respondJson(413, ['ok' => false, 'error' => 'Ukuran JPEG harus antara 4 byte dan 1 MB.']);
}
$image = file_get_contents('php://input', false, null, 0, 1048577);
if ($image === false || strlen($image) !== $contentLength ||
    substr($image, 0, 2) !== "\xFF\xD8" || substr($image, -2) !== "\xFF\xD9") {
    respondJson(400, ['ok' => false, 'error' => 'Body permintaan bukan file JPEG yang valid.']);
}

$storageDir = appConfig()['camera_storage_dir'];
if (!is_dir($storageDir) && !mkdir($storageDir, 0770, true) && !is_dir($storageDir)) {
    error_log('SIPATAR camera storage directory could not be created.');
    respondJson(500, ['ok' => false, 'error' => 'Folder penyimpanan snapshot tidak dapat dibuat.']);
}
$filename = bin2hex(random_bytes(16)) . '.jpg';
$filePath = rtrim($storageDir, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $filename;
if (file_put_contents($filePath, $image, LOCK_EX) !== strlen($image)) {
    @unlink($filePath);
    respondJson(500, ['ok' => false, 'error' => 'Snapshot gagal disimpan ke disk.']);
}

try {
    $statement = $pdo->prepare('INSERT INTO camera_snapshots (filename) VALUES (:filename)');
    $statement->execute(['filename' => $filename]);
    respondJson(201, ['ok' => true, 'id' => (int) $pdo->lastInsertId()]);
} catch (PDOException $error) {
    @unlink($filePath);
    error_log('SIPATAR camera metadata insert failed: ' . $error->getMessage());
    respondJson(500, ['ok' => false, 'error' => 'Data snapshot gagal disimpan ke database.']);
}
