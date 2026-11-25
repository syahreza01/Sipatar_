<?php

return [
    'db' => [
        'host' => '127.0.0.1',
        'port' => 3306,
        'database' => 'sipatar',
        'username' => 'root',
        'password' => '',
    ],
    'device_tokens' => [
        // GANTI DENGAN TOKEN RAHASIA (bebas asal kuat dan tidak ada spasi)
        'zona1' => 'http://10.197.238.137/api/sensors1',
        'zona2' => 'http://10.197.238.137/api/sensors2',
        'esp32cam' => 'http://10.197.238.112/stream',
    ],
    'camera_storage_dir' => dirname(__DIR__, 3) . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'sipatar' . DIRECTORY_SEPARATOR . 'camera',
];