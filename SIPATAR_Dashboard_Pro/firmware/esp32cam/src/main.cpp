// ESP32-CAM (AI Thinker) - Web server streaming sederhana
// Mandiri: tidak perlu board_config.h / camera_pins.h
//
// Pengaturan Arduino IDE:
//   Board            : ESP32 Dev Module (atau AI Thinker ESP32-CAM)
//   PSRAM            : Enabled
//   Partition Scheme : Huge APP (3MB No OTA/1MB SPIFFS)
//   Upload Speed     : 115200
//   Serial Monitor   : 115200 baud

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <HTTPClient.h>
#include "esp_camera.h"
#include "esp_http_server.h"
#include "local_config.h"
// Opsional (menonaktifkan brownout reset, hanya menyembunyikan masalah daya):
// #include "soc/soc.h"
// #include "soc/rtc_cntl_reg.h"

#ifndef SIPATAR_CAMERA_API_URL
#define SIPATAR_CAMERA_API_URL ""
#endif
#ifndef SIPATAR_CAMERA_TOKEN
#define SIPATAR_CAMERA_TOKEN ""
#endif
#ifndef CAMERA_UPLOAD_INTERVAL_MS
#define CAMERA_UPLOAD_INTERVAL_MS 300000UL
#endif

const char *ssid = WIFI_SSID;
const char *password = WIFI_PASSWORD;
unsigned long lastSnapshotUpload = 0;

// ===========================
// Pin kamera AI Thinker ESP32-CAM
// ===========================
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27

#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

#define LED_FLASH_PIN 4  // LED flash putih di board

httpd_handle_t httpd_server = NULL;

// ---------------------------------------------------------
// Halaman utama
// ---------------------------------------------------------
static const char INDEX_HTML[] =
  "<!DOCTYPE html><html><head><meta charset='utf-8'>"
  "<meta name='viewport' content='width=device-width,initial-scale=1'>"
  "<title>ESP32-CAM</title>"
  "<style>body{font-family:sans-serif;text-align:center;background:#111;color:#eee}"
  "img{max-width:100%;height:auto;border-radius:8px}"
  "a{color:#4af;margin:0 8px}</style></head><body>"
  "<h2>ESP32-CAM</h2>"
  "<img id='v' src=''>"
  "<p><a href='#' onclick=\"document.getElementById('v').src='/stream';return false\">Mulai Stream</a>"
  "<a href='/capture' target='_blank'>Ambil Foto</a></p>"
  "<script>document.getElementById('v').src='/stream'</script>"
  "</body></html>";

static esp_err_t index_handler(httpd_req_t *req) {
  httpd_resp_set_type(req, "text/html");
  return httpd_resp_send(req, INDEX_HTML, HTTPD_RESP_USE_STRLEN);
}

// ---------------------------------------------------------
// Ambil satu foto JPEG
// ---------------------------------------------------------
static esp_err_t capture_handler(httpd_req_t *req) {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Gagal mengambil gambar");
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=capture.jpg");
  esp_err_t res = httpd_resp_send(req, (const char *)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return res;
}

void uploadCameraSnapshot() {
  if (!SIPATAR_CAMERA_API_URL[0] || !SIPATAR_CAMERA_TOKEN[0]) {
    Serial.println("Laragon: isi SIPATAR_CAMERA_API_URL dan SIPATAR_CAMERA_TOKEN di local_config.h.");
    return;
  }

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Snapshot Laragon: gagal mengambil frame kamera.");
    return;
  }

  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, SIPATAR_CAMERA_API_URL)) {
    Serial.println("Snapshot Laragon: URL API tidak valid.");
    esp_camera_fb_return(fb);
    return;
  }
  http.setTimeout(8000);
  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-Device-Token", SIPATAR_CAMERA_TOKEN);
  const int status = http.POST(fb->buf, fb->len);
  const String responseBody = http.getString();
  http.end();
  esp_camera_fb_return(fb);

  if (status == HTTP_CODE_CREATED || status == HTTP_CODE_OK) {
    Serial.println("Snapshot berhasil disimpan di Laragon.");
  } else {
    Serial.printf("Snapshot Laragon gagal, HTTP %d: %s\n", status,
                  responseBody.c_str());
  }
}

// ---------------------------------------------------------
// Stream MJPEG
// ---------------------------------------------------------
#define PART_BOUNDARY "123456789000000000000987654321"
static const char *STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char *STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char *STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t stream_handler(httpd_req_t *req) {
  esp_err_t res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

  char part_buf[64];
  while (true) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("Gagal mengambil frame");
      res = ESP_FAIL;
    } else {
      size_t hlen = snprintf(part_buf, sizeof(part_buf), STREAM_PART, (unsigned)fb->len);
      res = httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
      if (res == ESP_OK) res = httpd_resp_send_chunk(req, part_buf, hlen);
      if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char *)fb->buf, fb->len);
      esp_camera_fb_return(fb);
    }
    if (res != ESP_OK) break;  // klien terputus
  }
  return res;
}

// ---------------------------------------------------------
// Start web server
// ---------------------------------------------------------
void startCameraServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;

  httpd_uri_t index_uri = { "/", HTTP_GET, index_handler, NULL };
  httpd_uri_t capture_uri = { "/capture", HTTP_GET, capture_handler, NULL };
  httpd_uri_t stream_uri = { "/stream", HTTP_GET, stream_handler, NULL };

  if (httpd_start(&httpd_server, &config) == ESP_OK) {
    httpd_register_uri_handler(httpd_server, &index_uri);
    httpd_register_uri_handler(httpd_server, &capture_uri);
    httpd_register_uri_handler(httpd_server, &stream_uri);
  } else {
    Serial.println("Gagal memulai web server");
  }
}

// ---------------------------------------------------------
// Inisialisasi kamera
// ---------------------------------------------------------
bool initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
#else
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
#endif
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 10000000;  // 10 MHz lebih stabil dari 20 MHz
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode = CAMERA_GRAB_LATEST;

  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA;  // 640x480
    config.jpeg_quality = 12;
    config.fb_count = 2;
    config.fb_location = CAMERA_FB_IN_PSRAM;
  } else {
    Serial.println("PERINGATAN: PSRAM tidak terdeteksi! Aktifkan PSRAM di menu Tools.");
    config.frame_size = FRAMESIZE_QVGA;  // 320x240
    config.jpeg_quality = 15;
    config.fb_count = 1;
    config.fb_location = CAMERA_FB_IN_DRAM;
  }

  // Coba sampai 3 kali (membantu kalau daya/koneksi belum stabil)
  esp_err_t err = ESP_FAIL;
  for (int i = 1; i <= 3; i++) {
    err = esp_camera_init(&config);
    if (err == ESP_OK) break;
    Serial.printf("Camera init gagal (percobaan %d/3), error 0x%x\n", i, err);
    esp_camera_deinit();
    delay(500);
  }
  if (err != ESP_OK) return false;

  sensor_t *s = esp_camera_sensor_get();
  if (s != NULL) {
    Serial.printf("Sensor terdeteksi, PID: 0x%x\n", s->id.PID);
    // Kalau gambar terbalik, hapus tanda // pada dua baris berikut:
    // s->set_vflip(s, 1);
    // s->set_hmirror(s, 1);
  }
  return true;
}

// ---------------------------------------------------------
void setup() {
  // WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);  // opsional, lihat catatan di atas

  Serial.begin(115200);
  Serial.setDebugOutput(false);
  delay(1500);  // beri waktu Serial Monitor siap
  Serial.println();
  Serial.println("=== ESP32-CAM mulai ===");

  pinMode(LED_FLASH_PIN, OUTPUT);
  digitalWrite(LED_FLASH_PIN, LOW);  // pastikan LED flash mati

  if (!initCamera()) {
    Serial.println("Kamera gagal diinisialisasi. Cek kabel pita kamera, daya 5V, dan PSRAM.");
    Serial.println("Board akan restart dalam 5 detik...");
    delay(5000);
    ESP.restart();
  }
  Serial.println("Kamera OK");

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  WiFi.setSleep(false);

  Serial.print("Menyambung ke Wi-Fi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (millis() - start > 30000) {
      Serial.println("\nGagal tersambung ke Wi-Fi. Cek SSID/password (harus 2.4 GHz). Restart...");
      delay(2000);
      ESP.restart();
    }
  }
  Serial.println("\nWi-Fi tersambung");

  startCameraServer();
  lastSnapshotUpload = millis();

  Serial.print("Kamera siap! Buka: http://");
  Serial.println(WiFi.localIP());
}

void loop() {
  // Web server berjalan di task terpisah.
  // Sambung ulang Wi-Fi otomatis jika terputus.
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi terputus, mencoba menyambung ulang...");
    WiFi.disconnect();
    WiFi.begin(ssid, password);
    delay(5000);
  }
  if (WiFi.status() == WL_CONNECTED &&
      millis() - lastSnapshotUpload >= CAMERA_UPLOAD_INTERVAL_MS) {
    lastSnapshotUpload = millis();
    uploadCameraSnapshot();
  }
  delay(10000);
}