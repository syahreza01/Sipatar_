# ESP32-CAM AI Thinker: Cara nyala dan upload firmware

## 1) Wiring yang benar

Gunakan FTDI / USB-TTL seperti ini:

- 5V  -> 5V
- GND -> GND
- TX FTDI -> RX ESP32-CAM (U0R / GPIO3)
- RX FTDI -> TX ESP32-CAM (U0T / GPIO1)
- GPIO0 -> GND saat upload

Catatan:
- GPIO0 harus dipasang ke GND HANYA SAAT UPLOAD.
- Setelah upload selesai, lepas GPIO0 dari GND.
- Jika board tetap tidak hidup, cek power dan GND terlebih dahulu.

## 2) Cara upload firmware

1. Hubungkan FTDI ke ESP32-CAM.
2. Sambungkan GPIO0 ke GND.
3. Tekan RESET.
4. Jalankan:

   pio run -t upload

5. Setelah upload mulai, lepaskan GPIO0 dari GND.
6. Tunggu sampai proses selesai.

## 3) Buka serial monitor

Gunakan baud rate 115200:

   pio device monitor -b 115200

Output yang diharapkan:

   ESP32-CAM AI THINKER
   BOOT TEST + CAMERA INIT
   CAMERA INIT SUCCESS

## 4) Kalau board tidak hidup

Periksa satu per satu:

- FTDI RX/TX benar
- GND terhubung
- power 5V stabil
- GPIO0 tidak tertinggal di GND
- board bukan rusak hardware

## 5) Catatan penting

- FTDI yang output 5V ke ESP32-CAM bisa berbahaya untuk pin RX jika tidak ada pembagi tegangan. Jika FTDI Anda 5V, gunakan resistor pembagi 5V ke 3.3V untuk jalur TX FTDI -> RX ESP32-CAM.
- Untuk upload normal, biasanya board 3.3V FTDI aman.

## 6) Firmware yang sudah siap

Project ini sudah dipersiapkan dengan pin AI Thinker yang benar pada file:

- src/main.cpp
- src/camera_pinout.h

Jangan lupa untuk menghapus sementara GPIO0 dari GND saat board sudah boot normal.
