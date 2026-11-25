#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <DHT.h>
#include <ArduinoJson.h>
#include <time.h>
#include <string.h>
#include "local_config.h"
#include "telegram_root_ca.h"

#ifndef DEVICE_ID
#define DEVICE_ID "zona1"
#endif
#ifndef SIPATAR_API_URL
#define SIPATAR_API_URL ""
#endif
#ifndef SIPATAR_DEVICE_TOKEN
#define SIPATAR_DEVICE_TOKEN ""
#endif

const bool DEVICE_HAS_DHT = strcmp(DEVICE_ID, "zona1") == 0;

const char *ssid = WIFI_SSID;
const char *password = WIFI_PASSWORD;

constexpr uint8_t FLAME_PIN = D1;
constexpr uint8_t DHT_PIN = D2;
constexpr uint8_t MQ2_PIN = A0;
constexpr uint8_t BUZZER_PIN = D7;
constexpr uint8_t LED_GREEN_PIN = D0;
constexpr uint8_t LED_YELLOW_PIN = D6;
constexpr uint8_t LED_RED_PIN = D8;

constexpr float TEMP_THRESHOLD = 40.0;
constexpr int GAS_THRESHOLD = 400;
constexpr long LOCAL_TIME_OFFSET_SECONDS = 7L * 3600L;
constexpr unsigned long CONFIRMATION_MS = 5000;
constexpr unsigned long DHT_INTERVAL_MS = 2000;
// ADC ESP8266 berbagi sumber daya dengan Wi-Fi; jangan dibaca tiap putaran loop.
constexpr unsigned long GAS_INTERVAL_MS = 250;
constexpr unsigned long OUTPUT_INTERVAL_MS = 200;
constexpr unsigned long LOG_INTERVAL_MS = 1000;
constexpr unsigned long SERVER_UPLOAD_INTERVAL_MS = 10000;
constexpr unsigned long IP_LOG_INTERVAL_MS = 10000;
constexpr unsigned long TELEGRAM_RETRY_INTERVAL_MS = 30000;

#ifndef TELEGRAM_ENABLED
#define TELEGRAM_ENABLED false
#endif
#ifndef TELEGRAM_BOT_TOKEN
#define TELEGRAM_BOT_TOKEN ""
#endif
#ifndef TELEGRAM_CHAT_ID
#define TELEGRAM_CHAT_ID ""
#endif
#ifndef TELEGRAM_NOTIFY_WARNING
#define TELEGRAM_NOTIFY_WARNING true
#endif
#ifndef TELEGRAM_NOTIFY_FIRE
#define TELEGRAM_NOTIFY_FIRE true
#endif
#ifndef TELEGRAM_NOTIFY_RECOVERY
#define TELEGRAM_NOTIFY_RECOVERY false
#endif

constexpr bool NOTIFY_WARNING = TELEGRAM_NOTIFY_WARNING;
constexpr bool NOTIFY_FIRE = TELEGRAM_NOTIFY_FIRE;
constexpr bool NOTIFY_RECOVERY = TELEGRAM_NOTIFY_RECOVERY;

ESP8266WebServer server(80);
DHT dht(DHT_PIN, DHT22);
BearSSL::X509List telegramTrustAnchor(TELEGRAM_ROOT_CA);
WiFiEventHandler wifiDisconnectHandler;

float temperature = NAN;
float humidity = NAN;
int gas = 0;
bool flameDetected = false;
bool suspicious = false;
bool fireDetected = false;
bool dhtReadingValid = false;
bool dhtTemperatureValid = false;
bool dhtHumidityValid = false;
unsigned long suspiciousSince = 0;
unsigned long lastDhtRead = 0;
unsigned long lastGasRead = 0;
unsigned long lastOutputUpdate = 0;
unsigned long lastLog = 0;
unsigned long lastServerUpload = 0;
unsigned long lastNtpLog = 0;
unsigned long lastIpLog = 0;
unsigned long lastWifiAttempt = 0;
bool warningBlinkOn = false;
bool wifiWasConnected = false;
String pendingTelegramMessage;
unsigned long lastTelegramAttempt = 0;
bool telegramAttempted = false;
int previousAlarmLevel = 0;
bool alarmStateInitialized = false;

// Ubah ke 1 hanya untuk diagnosis sementara; jangan gunakan dengan kredensial nyata.
#define TLS_INSECURE_DEBUG 0

void configureTls(BearSSL::WiFiClientSecure &client) {
#if TLS_INSECURE_DEBUG
  client.setInsecure();
#else
  client.setX509Time(time(nullptr));
  client.setTrustAnchors(&telegramTrustAnchor);
#endif
}

String encodeQueryValue(const String &value) {
  String encoded;
  const char hex[] = "0123456789ABCDEF";
  for (size_t i = 0; i < value.length(); i++) {
    const uint8_t c = static_cast<uint8_t>(value[i]);
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      encoded += static_cast<char>(c);
    } else {
      encoded += '%';
      encoded += hex[c >> 4];
      encoded += hex[c & 0x0F];
    }
  }
  return encoded;
}

String formatLocalDateTime() {
  const time_t now = time(nullptr);
  if (now < 1700000000) {
    return "Tanggal/Waktu: menunggu sinkronisasi NTP";
  }

  struct tm localTime;
  if (!localtime_r(&now, &localTime)) {
    return "Tanggal/Waktu: tidak tersedia";
  }
  char date[16];
  char clock[16];
  if (strftime(date, sizeof(date), "%d-%m-%Y", &localTime) == 0 ||
      strftime(clock, sizeof(clock), "%H:%M:%S", &localTime) == 0) {
    return "Tanggal/Waktu: tidak tersedia";
  }
  return String("Tanggal: ") + date + "\nWaktu: " + clock + " WIB";
}

bool sendTelegramMessage(const String &message) {
  if (!TELEGRAM_ENABLED || !TELEGRAM_BOT_TOKEN[0] || !TELEGRAM_CHAT_ID[0] ||
      WiFi.status() != WL_CONNECTED || time(nullptr) < 1700000000) {
    return false;
  }

  BearSSL::WiFiClientSecure client;
  configureTls(client);
  HTTPClient http;
  String url = "https://api.telegram.org/bot";
  url += TELEGRAM_BOT_TOKEN;
  url += "/sendMessage";
  if (!http.begin(client, url)) {
    Serial.println("Telegram: gagal memulai koneksi HTTPS.");
    return false;
  }
  http.setTimeout(6000);
  http.addHeader("Content-Type", "application/x-www-form-urlencoded");
  const String body = "chat_id=" + encodeQueryValue(String(TELEGRAM_CHAT_ID)) +
                      "&text=" + encodeQueryValue(message);
  const int status = http.POST(body);
  const String responseBody = http.getString();
  http.end();
  if (status < 0) {
    Serial.printf("Telegram: koneksi gagal (%s).\n",
                  HTTPClient::errorToString(status).c_str());
    return false;
  }
  if (status != HTTP_CODE_OK) {
    Serial.printf("Telegram: pengiriman gagal, HTTP %d.\n", status);
    return false;
  }

  JsonDocument response;
  const DeserializationError error = deserializeJson(response, responseBody);
  if (error || !response["ok"].as<bool>()) {
    Serial.println("Telegram: API menolak pesan atau respons tidak valid.");
    return false;
  }
  Serial.println("Telegram: notifikasi berhasil dikirim.");
  return true;
}

void queueTelegramNotification(int alarmLevel) {
  if (!TELEGRAM_ENABLED || !TELEGRAM_BOT_TOKEN[0] || !TELEGRAM_CHAT_ID[0]) {
    return;
  }

  String message = "SIPATAR - MONITORING KEBAKARAN\n";
  message += alarmLevel == 2 ? "ALARM KEBAKARAN" :
             alarmLevel == 1 ? "PERINGATAN WASPADA" : "KONDISI KEMBALI AMAN";
  message += "\nNode: ESP8266 ";
  message += DEVICE_ID;
  message += "\n";
  message += formatLocalDateTime();
  message += "\n\nSuhu: ";
  if (!DEVICE_HAS_DHT) {
    message += "tidak digunakan";
  } else if (isnan(temperature)) {
    message += "tidak terbaca";
  } else {
    message += String(temperature, 1) + " C";
  }
  message += "\nKelembapan: ";
  if (!DEVICE_HAS_DHT) {
    message += "tidak digunakan";
  } else if (isnan(humidity)) {
    message += "tidak terbaca";
  } else {
    message += String(humidity, 1) + " %";
  }
  message += "\nGas MQ-2: " + String(gas) + " ADC";
  message += "\nFlame sensor: ";
  message += flameDetected ? "API" : "Aman";
  const int riskScore = (flameDetected ? 2 : 0) +
                        (gas >= GAS_THRESHOLD ? 1 : 0) +
                        (!isnan(temperature) && temperature >= TEMP_THRESHOLD ? 1 : 0);
  message += "\nSkor risiko: " + String(riskScore) + "/4";
  message += "\nPemicu: ";
  bool hasCause = false;
  if (flameDetected) {
    message += "flame sensor aktif";
    hasCause = true;
  }
  if (gas >= GAS_THRESHOLD) {
    message += hasCause ? ", gas melewati ambang" : "gas melewati ambang";
    hasCause = true;
  }
  if (!isnan(temperature) && temperature >= TEMP_THRESHOLD) {
    message += hasCause ? ", suhu melewati ambang" : "suhu melewati ambang";
    hasCause = true;
  }
  if (alarmLevel == 2 && !flameDetected) {
    message += hasCause ? ", kondisi bertahan lebih dari 5 detik"
                        : "kondisi bertahan lebih dari 5 detik";
    hasCause = true;
  }
  if (!hasCause) {
    message += "semua pembacaan kembali normal";
  }

  if (pendingTelegramMessage.isEmpty()) {
    pendingTelegramMessage = message;
  } else if (pendingTelegramMessage.length() + message.length() + 1 <= 1000) {
    pendingTelegramMessage += "\n\n" + message;
  } else {
    pendingTelegramMessage = message;
  }
}

void processTelegramQueue(unsigned long now) {
  if (pendingTelegramMessage.isEmpty() ||
      (telegramAttempted && now - lastTelegramAttempt < TELEGRAM_RETRY_INTERVAL_MS)) {
    return;
  }
  pendingTelegramMessage.replace("Tanggal/Waktu: menunggu sinkronisasi NTP",
                                 formatLocalDateTime());
  telegramAttempted = true;
  lastTelegramAttempt = now;
  if (sendTelegramMessage(pendingTelegramMessage)) {
    pendingTelegramMessage = "";
    telegramAttempted = false;
  }
}

void uploadSensorSample() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }
  if (DEVICE_HAS_DHT && (!dhtReadingValid || isnan(temperature) || isnan(humidity))) {
    Serial.printf("Laragon: upload dilewati; DHT22 suhu %s, kelembapan %s.\n",
                  dhtTemperatureValid ? "terbaca" : "belum terbaca",
                  dhtHumidityValid ? "terbaca" : "belum terbaca");
    return;
  }
  if (!SIPATAR_API_URL[0] || !SIPATAR_DEVICE_TOKEN[0]) {
    Serial.println("Laragon: isi SIPATAR_API_URL dan SIPATAR_DEVICE_TOKEN di local_config.h.");
    return;
  }

  JsonDocument body;
  if (DEVICE_HAS_DHT) {
    body["temperature"] = temperature;
    body["humidity"] = humidity;
  } else {
    body["temperature"] = nullptr;
    body["humidity"] = nullptr;
  }
  body["gas"] = gas;
  body["flameDetected"] = flameDetected;
  String payload;
  serializeJson(body, payload);

  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, SIPATAR_API_URL)) {
    Serial.println("Laragon: URL API tidak valid.");
    return;
  }
  http.setTimeout(5000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Token", SIPATAR_DEVICE_TOKEN);
  const int status = http.POST(payload);
  const String responseBody = http.getString();
  http.end();
  if (status == HTTP_CODE_CREATED || status == HTTP_CODE_OK) {
    Serial.printf("Laragon: data %s berhasil disimpan.\n", DEVICE_ID);
  } else {
    Serial.printf("Laragon: upload %s gagal, HTTP %d: %s\n",
                  DEVICE_ID, status, responseBody.c_str());
  }
}

void addCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
}

void handleSensors() {
  addCorsHeaders();
  if (DEVICE_HAS_DHT && (!dhtReadingValid || isnan(temperature) || isnan(humidity))) {
    server.send(503, "application/json", "{\"error\":\"DHT22 tidak terbaca\"}");
    return;
  }

  String json = "{\"temperature\":";
  if (DEVICE_HAS_DHT) {
    json += String(temperature, 1);
  } else {
    json += "null";
  }
  json += ",\"humidity\":";
  if (DEVICE_HAS_DHT) {
    json += String(humidity, 1);
  } else {
    json += "null";
  }
  json += ",\"gas\":";
  json += String(gas);
  json += ",\"flameDetected\":";
  json += flameDetected ? "true" : "false";
  json += ",\"smokeDetected\":";
  json += gas >= GAS_THRESHOLD ? "true" : "false";
  json += ",\"riskScore\":";
  json += (flameDetected ? 2 : 0) + (gas >= GAS_THRESHOLD ? 1 : 0) +
          (DEVICE_HAS_DHT && !isnan(temperature) && temperature >= TEMP_THRESHOLD ? 1 : 0);
  json += ",\"alarmStatus\":\"";
  json += fireDetected ? "KEBAKARAN" : (suspicious ? "WASPADA" : "AMAN");
  json += "\",\"deviceId\":\"";
  json += DEVICE_ID;
  json += "\"}";
  server.send(200, "application/json", json);
}

void handleOptions() {
  addCorsHeaders();
  server.send(204);
}

void updateSensors(unsigned long now) {
  if (now - lastGasRead >= GAS_INTERVAL_MS) {
    lastGasRead = now;
    gas = analogRead(MQ2_PIN);
  }
  flameDetected = digitalRead(FLAME_PIN) == LOW;

  if (DEVICE_HAS_DHT && now - lastDhtRead >= DHT_INTERVAL_MS) {
    lastDhtRead = now;
    const float newHumidity = dht.readHumidity();
    const float newTemperature = dht.readTemperature();
    dhtHumidityValid = !isnan(newHumidity);
    dhtTemperatureValid = !isnan(newTemperature);
    dhtReadingValid = dhtHumidityValid && dhtTemperatureValid;
    if (dhtReadingValid) {
      humidity = newHumidity;
      temperature = newTemperature;
    }
  }
}

void updateAlarm(unsigned long now) {
  const bool smokeDetected = gas >= GAS_THRESHOLD;
  const bool temperatureHigh = !isnan(temperature) && temperature >= TEMP_THRESHOLD;
  const int score = (flameDetected ? 2 : 0) + (smokeDetected ? 1 : 0) +
                    (temperatureHigh ? 1 : 0);

  if (score >= 1) {
    if (!suspicious) {
      suspicious = true;
      suspiciousSince = now;
    }
    if (now - suspiciousSince >= CONFIRMATION_MS || flameDetected) {
      fireDetected = true;
    }
  } else {
    suspicious = false;
    fireDetected = false;
  }

  const int alarmLevel = fireDetected ? 2 : suspicious ? 1 : 0;
  if (!alarmStateInitialized || alarmLevel != previousAlarmLevel) {
    if (alarmLevel == 2 && NOTIFY_FIRE) {
      queueTelegramNotification(alarmLevel);
    } else if (alarmLevel == 1 && NOTIFY_WARNING) {
      queueTelegramNotification(alarmLevel);
    } else if (alarmLevel == 0 && alarmStateInitialized &&
               previousAlarmLevel > 0 && NOTIFY_RECOVERY) {
      queueTelegramNotification(alarmLevel);
    }
    previousAlarmLevel = alarmLevel;
    alarmStateInitialized = true;
  }

  if (now - lastOutputUpdate < OUTPUT_INTERVAL_MS) {
    return;
  }
  lastOutputUpdate = now;

  if (fireDetected) {
    digitalWrite(LED_GREEN_PIN, LOW);
    digitalWrite(LED_YELLOW_PIN, LOW);
    digitalWrite(LED_RED_PIN, HIGH);
    digitalWrite(BUZZER_PIN, HIGH);
  } else if (suspicious) {
    warningBlinkOn = !warningBlinkOn;
    digitalWrite(LED_GREEN_PIN, LOW);
    digitalWrite(LED_RED_PIN, LOW);
    digitalWrite(LED_YELLOW_PIN, warningBlinkOn ? HIGH : LOW);
    digitalWrite(BUZZER_PIN, warningBlinkOn ? HIGH : LOW);
  } else {
    digitalWrite(LED_GREEN_PIN, HIGH);
    digitalWrite(LED_YELLOW_PIN, LOW);
    digitalWrite(LED_RED_PIN, LOW);
    digitalWrite(BUZZER_PIN, LOW);
  }
}

void logStatus(unsigned long now) {
  if (now - lastLog < LOG_INTERVAL_MS) {
    return;
  }
  lastLog = now;

  const int score = (flameDetected ? 2 : 0) + (gas >= GAS_THRESHOLD ? 1 : 0) +
                    (!isnan(temperature) && temperature >= TEMP_THRESHOLD ? 1 : 0);
  Serial.printf("Flame: %s | MQ-2: %d | Suhu: ",
                flameDetected ? "API" : "Aman", gas);
  if (!DEVICE_HAS_DHT) {
    Serial.print("tidak digunakan");
  } else if (isnan(temperature)) {
    Serial.print("tidak terbaca");
  } else {
    Serial.printf("%.1f C", temperature);
  }
  Serial.printf(" | Skor: %d | Status: %s\n", score,
                fireDetected ? "KEBAKARAN" : (suspicious ? "WASPADA" : "AMAN"));
}

// Scan, lalu sambung memakai channel + BSSID AP terkuat dengan SSID yang cocok.
// Ini menghindari error "reason 201: access point tidak ditemukan" pada hotspot HP.
void connectWifi() {
  WiFi.disconnect();
  int32_t channel = 0;
  uint8_t bssid[6] = {};
  int best = -1;
  const int networkCount = WiFi.scanNetworks();
  for (int i = 0; i < networkCount; i++) {
    if (WiFi.SSID(i) == ssid && (best < 0 || WiFi.RSSI(i) > WiFi.RSSI(best))) {
      best = i;
    }
  }
  if (best >= 0) {
    channel = WiFi.channel(best);
    memcpy(bssid, WiFi.BSSID(best), 6);
    Serial.printf("SSID ditemukan (sinyal %d dBm, channel %d). Menyambung ke AP tersebut.\n",
                  WiFi.RSSI(best), static_cast<int>(channel));
  } else {
    Serial.println("SSID konfigurasi tidak terlihat. Periksa WIFI_SSID dan pastikan Wi-Fi 2,4 GHz aktif (hotspot iPhone: aktifkan Maximize Compatibility).");
  }
  WiFi.scanDelete();
  if (best >= 0) {
    WiFi.begin(ssid, password, channel, bssid);
  } else {
    WiFi.begin(ssid, password);
  }
}

void setup() {
  Serial.begin(115200);
  if (!TELEGRAM_ENABLED) {
    Serial.println("Telegram: notifikasi otomatis nonaktif.");
  } else if (!TELEGRAM_BOT_TOKEN[0] || !TELEGRAM_CHAT_ID[0]) {
    Serial.println("Telegram: isi token bot dan Chat ID di local_config.h.");
  } else {
    Serial.println("Telegram: notifikasi otomatis aktif.");
  }
  pinMode(FLAME_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_GREEN_PIN, OUTPUT);
  pinMode(LED_YELLOW_PIN, OUTPUT);
  pinMode(LED_RED_PIN, OUTPUT);

  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(LED_GREEN_PIN, LOW);
  digitalWrite(LED_YELLOW_PIN, LOW);
  digitalWrite(LED_RED_PIN, LOW);
  if (DEVICE_HAS_DHT) {
    dht.begin();
  }

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
  WiFi.setAutoReconnect(true);
  wifiDisconnectHandler = WiFi.onStationModeDisconnected(
      [](const WiFiEventStationModeDisconnected &event) {
        const int reason = static_cast<int>(event.reason);
        Serial.printf("Wi-Fi terputus (reason %d): ", reason);
        switch (event.reason) {
        case WIFI_DISCONNECT_REASON_AUTH_EXPIRE:
          Serial.println("autentikasi dihentikan access point sebelum koneksi selesai.");
          break;
        case WIFI_DISCONNECT_REASON_NO_AP_FOUND:
          Serial.println("access point tidak ditemukan.");
          break;
        case WIFI_DISCONNECT_REASON_AUTH_FAIL:
          Serial.println("autentikasi gagal; periksa keamanan atau password router.");
          break;
        case WIFI_DISCONNECT_REASON_ASSOC_FAIL:
          Serial.println("router menolak asosiasi perangkat.");
          break;
        case WIFI_DISCONNECT_REASON_HANDSHAKE_TIMEOUT:
        case WIFI_DISCONNECT_REASON_4WAY_HANDSHAKE_TIMEOUT:
          Serial.println("handshake keamanan timeout; periksa sinyal dan keamanan Wi-Fi.");
          break;
        default:
          Serial.println("alasan lain; gunakan kode reason untuk diagnosis.");
          break;
        }
      });
  Serial.println("Memeriksa jaringan Wi-Fi yang dikonfigurasi...");
  connectWifi();
  Serial.print("Menghubungkan ke Wi-Fi");
  lastWifiAttempt = millis();

  server.on("/api/sensors1", HTTP_GET, handleSensors);
  server.on("/api/sensors1", HTTP_OPTIONS, handleOptions);
  server.onNotFound([]() {
    addCorsHeaders();
    server.send(404, "application/json", "{\"error\":\"Endpoint tidak ditemukan\"}");
  });
  server.begin();
  Serial.println("\nServer HTTP siap; koneksi Wi-Fi berjalan di latar belakang.");
}

void loop() {
  const unsigned long now = millis();
  const bool wifiConnected = WiFi.status() == WL_CONNECTED;
  if (wifiConnected && !wifiWasConnected) {
    wifiWasConnected = true;
    Serial.println();
    Serial.print("ESP8266 terhubung. IP: ");
    Serial.println(WiFi.localIP());
    Serial.println("Endpoint sensor: http://" + WiFi.localIP().toString() + "/api/sensors1");
    configTime(LOCAL_TIME_OFFSET_SECONDS, 0, "pool.ntp.org", "time.google.com",
               "time.nist.gov");
    Serial.println("Sinkronisasi NTP berjalan untuk notifikasi Telegram.");
  } else if (!wifiConnected && wifiWasConnected) {
    wifiWasConnected = false;
    Serial.println("Wi-Fi terputus; mencoba menyambung kembali.");
  }
  if (wifiConnected && now - lastIpLog >= IP_LOG_INTERVAL_MS) {
    lastIpLog = now;
    Serial.print("IP ESP8266: ");
    Serial.println(WiFi.localIP());
  }
  if (!wifiConnected && now - lastWifiAttempt >= 30000) {
    lastWifiAttempt = now;
    Serial.printf("Wi-Fi belum tersambung (status %d). Scan ulang lalu mencoba menyambung.\n",
                  static_cast<int>(WiFi.status()));
    connectWifi();
  }

  updateSensors(now);
  updateAlarm(now);
  logStatus(now);
  server.handleClient();
  processTelegramQueue(now);
  if (wifiConnected && time(nullptr) < 1700000000 &&
      now - lastNtpLog >= 30000) {
    lastNtpLog = now;
    IPAddress ntpAddress;
    const bool dnsResolved = WiFi.hostByName("pool.ntp.org", ntpAddress) == 1;
    Serial.printf("NTP belum sinkron; Wi-Fi %s; DNS pool.ntp.org %s. Periksa internet router dan akses NTP (UDP port 123).\n",
                  WiFi.status() == WL_CONNECTED ? "tersambung" : "terputus",
                  dnsResolved ? ntpAddress.toString().c_str() : "gagal");
  }
  if (now - lastServerUpload >= SERVER_UPLOAD_INTERVAL_MS) {
    lastServerUpload = now;
    uploadSensorSample();
  }
  yield();
}