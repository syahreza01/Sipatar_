# SIPATAR Dashboard Pro (Windows + Laragon)

## Menjalankan dashboard dengan Laragon
Folder Laragon `D:\laragon\www\SIPATAR` sudah diisi dengan dashboard dan API. Jika menyalin proyek ini ke komputer lain, salin `web\index.html`, `web\app.js`, `web\style.css`, dan folder `api` ke folder `SIPATAR`.
1. Buka Laragon, lalu jalankan **Apache** dan **MySQL**.
2. Buka `http://localhost/phpmyadmin`, pilih **Import**, lalu jalankan `api/schema.sql`.
3. Salin `api/config.example.php` menjadi `api/config.local.php`. Atur kredensial MySQL bila berbeda, lalu ganti tiga token contoh dengan nilai rahasia yang berbeda untuk `zona1`, `zona2`, dan `esp32cam`.
4. Buka `http://localhost/SIPATAR/`. Jangan gunakan Live Server atau buka HTML lewat `file://`; API PHP dan MySQL memerlukan Apache Laragon.
5. Untuk menerima data dari perangkat, cari alamat IPv4 komputer dengan `ipconfig`, lalu gunakan alamat itu pada URL API firmware. Pastikan firewall Windows mengizinkan Apache pada jaringan lokal.

Folder foto default berada di `D:\laragon\data\sipatar\camera`, di luar folder publik web. Sesuaikan `camera_storage_dir` pada `api/config.local.php` jika lokasi instalasi Laragon berbeda.

## Fitur yang tersedia
- Dashboard monitoring dan grafik canvas.
- Halaman kamera: live stream ESP32-CAM dan galeri snapshot yang disimpan di komputer Laragon.
- Perangkat & sensor: ESP8266 Zona 1 dan Zona 2 mengirim pembacaan ke MySQL melalui API PHP.
- Laporan kejadian: filter, catat, hapus, ekspor CSV.
- ACL demo: tambah pengguna, ubah peran, aktif/nonaktif.
- Login demo, logout, navigasi berdasarkan role.
- Uji kirim pesan Telegram melalui API PHP lokal.
- Pengaturan ambang demo, tema, backup JSON, reset data.
- Pengaturan ambang peringatan dashboard untuk suhu, kelembapan, gas/asap, dan flame sensor.

## Kredensial demo
- Admin: `admin` / `sipatar123`
- Operator: `operator` / `operator123`
- Viewer: `viewer` / `viewer123`

Dashboard otomatis membuka sesi Admin saat pertama kali dipreview agar mudah dicoba. Gunakan tombol **Keluar** untuk menguji halaman login.

## Database dan API Laragon
`api/schema.sql` membuat tabel `sensor_readings` untuk data dua zona dan `camera_snapshots` untuk metadata foto. Pembacaan sensor diterima di `api/readings.php`; snapshot JPEG diterima di `api/camera.php`. API hanya menerima penulisan dari perangkat dengan token yang cocok di `api/config.local.php`. Gunakan token acak yang berbeda untuk setiap board, jangan bagikan atau commit file `config.local.php`.

ESP dan komputer Laragon harus berada di Wi-Fi/jaringan yang sama. Pada firmware, gunakan alamat IPv4 komputer (bukan `localhost` atau `127.0.0.1`), misalnya `http://192.168.1.10/SIPATAR/api/readings.php`. Buat DHCP reservation agar alamat komputer dan perangkat tidak berubah. API memakai HTTP untuk jaringan lokal; jangan membuka port Apache ke internet.

## Menghubungkan ESP8266 Zona 1 dan Zona 2
Firmware ada di folder proyek sumber `firmware/esp8266_sensor`. Di PlatformIO, jika `include/local_config.h` belum ada, salin `include/local_config.example.h` menjadi file tersebut. Jika file sudah ada, jangan ditimpa; pertahankan Wi-Fi/Telegram dan isi atau perbarui `DEVICE_ID`, `SIPATAR_API_URL`, serta token agar sama dengan konfigurasi Laragon.

Unggah firmware yang sama ke kedua board, tetapi atur `DEVICE_ID` dan `SIPATAR_DEVICE_TOKEN` untuk masing-masing:
- ESP8266 pertama: `DEVICE_ID "zona1"` dengan token `zona1`.
- ESP8266 kedua: `DEVICE_ID "zona2"` dengan token `zona2`. Zona 2 dapat berjalan tanpa DHT22; data suhu dan kelembapannya akan kosong, sementara flame dan MQ-2 tetap dikirim.

Ubah konfigurasi sebelum mengunggah ke board berikutnya. Firmware mengirim pembacaan setiap 10 detik. Zona 1 mengirim suhu, kelembapan, ADC gas, dan status flame; Zona 2 mengirim ADC gas dan status flame tanpa membaca DHT22. Jika database sudah dibuat sebelum Zona 2 berjalan tanpa DHT22, jalankan `api/migrate-zone2-no-dht.sql` satu kali di database SIPATAR agar kolom suhu dan kelembapan bisa menyimpan `NULL`. Pada kartu Zona 2 dan grafik, suhu/kelembapan yang tidak tersedia ditampilkan sebagai `—`. `GET /api/sensors1` tetap tersedia pada ESP8266 untuk pemeriksaan lokal. Cocokkan pin sensor dengan rangkaian: flame D1, DHT22 D2 (Zona 1), MQ-2 A0, buzzer D7, LED hijau D0, LED kuning D6, dan LED merah D8. D8 adalah pin boot; rangkaian harus menjaga pin ini LOW saat board mulai boot.

## Menghubungkan ESP32-CAM
Sebelum upload, jika `firmware/esp32cam/include/local_config.h` belum ada, salin `local_config.example.h` menjadi `local_config.h`. Jika sudah ada, pertahankan Wi-Fi dan tambahkan/perbarui `SIPATAR_CAMERA_API_URL` (alamat `api/camera.php` pada IP komputer Laragon, misalnya `http://192.168.1.10/SIPATAR/api/camera.php`) serta `SIPATAR_CAMERA_TOKEN` yang sama dengan token `esp32cam` di `api/config.local.php`.

Setelah firmware berjalan, Serial Monitor menampilkan IP kamera. Masukkan URL `http://IP_KAMERA/stream` pada menu Kamera di dashboard untuk live stream; snapshot JPEG diunggah ke Laragon setiap 5 menit secara default. Foto dapat dilihat pada galeri Kamera. Snapshot disimpan di disk Laragon, sedangkan metadata dan waktunya dicatat di MySQL.

Ambang pada menu Pengaturan dipakai untuk menilai status/peringatan di dashboard, termasuk saat mode perangkat nyata. Perubahan ambang dashboard tidak mengirim konfigurasi ke ESP8266; ambang buzzer dan LED perangkat masih diatur terpisah di firmware. Flame sensor mendeteksi api secara digital, bukan suhu. Untuk memicu peringatan berdasarkan °C, gunakan nilai dari DHT22 dan atur ambang suhu.

MQ-2 dibaca sebagai nilai ADC mentah. Pastikan tegangan pada pin A0 tidak melebihi batas board ESP8266 yang digunakan; modul NodeMCU umumnya memiliki pembagi tegangan bawaan, sedangkan bare ESP8266 tidak. Contoh firmware ini untuk prototipe dan tidak menggantikan sistem alarm kebakaran tersertifikasi.

## Menguji Telegram Bot
1. Buat bot melalui `@BotFather` di Telegram dan salin token bot. Jangan bagikan token kepada orang lain.
2. Mulai percakapan dengan bot melalui `/start`, atau tambahkan bot ke kanal/grup tujuan. Gunakan Chat ID numerik atau username kanal publik (`@nama_kanal`).
3. Untuk notifikasi otomatis yang tetap aktif saat dashboard ditutup, atur `#define TELEGRAM_ENABLED true`, `#define TELEGRAM_BOT_TOKEN "TOKEN_DARI_BOTFATHER"`, dan `#define TELEGRAM_CHAT_ID "CHAT_ID"` di `firmware/esp8266_sensor/include/local_config.h`. Atur `#define TELEGRAM_NOTIFY_WARNING true`, `#define TELEGRAM_NOTIFY_FIRE true`, dan `#define TELEGRAM_NOTIFY_RECOVERY false` sesuai kebutuhan.
4. Unggah ulang firmware ESP8266. Perangkat mengirim satu pesan saat status berubah ke Waspada/Kebakaran dan, jika diaktifkan, saat kembali normal. Pesan memuat tanggal, waktu WIB, suhu, kelembapan, gas, status flame, skor, dan pemicu. Untuk WITA/WIT, ubah `LOCAL_TIME_OFFSET_SECONDS` di `src/main.cpp` menjadi `8L * 3600L` atau `9L * 3600L`. Pastikan koneksi internet dan waktu NTP tersedia.
5. Untuk uji manual, buka dashboard melalui Laragon, lalu pilih menu Telegram Bot dan tekan **Kirim pesan uji**. Token uji hanya dipakai untuk satu permintaan dan tidak disimpan oleh dashboard. Ekstensi PHP cURL perlu aktif.

## Catatan keamanan dan integrasi
- Login dan ACL saat ini hanya demonstrasi di browser, bukan keamanan server. Batasi Apache/MySQL ke jaringan lokal dan gunakan token perangkat yang kuat; API HTTP lokal tidak mengenkripsi token.
- Bot token pada firmware dapat diekstrak dari perangkat; gunakan bot khusus dan jangan bagikan `local_config.h`. ESP8266 tidak dapat mengirim notifikasi ketika sedang offline; pemantauan offline memerlukan layanan cloud yang tetap berjalan.
- Snapshot kamera tersimpan terus-menerus dan akan menggunakan ruang disk; sesuaikan interval unggah `CAMERA_UPLOAD_INTERVAL_MS` atau buat kebijakan pengarsipan sesuai kebutuhan.
- Data sensor pada mode demo adalah data buatan. MQ-2 ditampilkan sebagai nilai ADC, bukan ppm.
- Jangan mengandalkan prototipe ini sebagai satu-satunya sistem keselamatan kebakaran.
