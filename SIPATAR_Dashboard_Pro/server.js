"use strict";

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");

const HOST = "127.0.0.1";
const PORT = 3000;
const WEB_ROOT = path.join(__dirname, "web");
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    request.setEncoding("utf8");
    request.on("data", chunk => {
      if (settled) return;
      body += chunk;
      if (body.length > 4096) {
        settled = true;
        reject(new Error("Ukuran permintaan terlalu besar."));
        request.resume();
      }
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Format permintaan tidak valid."));
      }
    });
    request.on("error", error => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function sendTelegramMessage(token, chatId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: chatId,
      text: "[SIPATAR] Pesan uji berhasil. Koneksi bot dan Chat ID aktif."
    });
    const request = https.request({
      hostname: "api.telegram.org",
      path: `/bot${token}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      },
      timeout: 10000
    }, response => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        responseBody += chunk;
        if (responseBody.length > 16384) response.destroy();
      });
      response.on("end", () => {
        let result;
        try {
          result = JSON.parse(responseBody);
        } catch {
          reject(new Error("Telegram mengirim respons yang tidak dapat dibaca."));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300 || !result.ok) {
          reject(new Error(result.description || `Telegram merespons HTTP ${response.statusCode}.`));
          return;
        }
        resolve();
      });
      response.on("error", () => reject(new Error("Respons Telegram terputus.")));
    });
    request.on("timeout", () => request.destroy(new Error("Waktu koneksi ke Telegram habis.")));
    request.on("error", error => reject(new Error(error.message || "Tidak dapat terhubung ke Telegram.")));
    request.end(body);
  });
}

async function handleTelegramTest(request, response) {
  if (request.headers.host !== `${HOST}:${PORT}` || request.headers.origin !== `http://${HOST}:${PORT}`) {
    sendJson(response, 403, { ok: false, error: "Permintaan harus berasal dari dashboard lokal." });
    return;
  }

  let payload;
  try {
    payload = await readJson(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
    return;
  }

  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  const chatId = typeof payload.chatId === "string" ? payload.chatId.trim() : "";
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    sendJson(response, 400, { ok: false, error: "Format Bot token tidak valid. Salin token dari BotFather." });
    return;
  }
  if (!chatId || chatId.length > 128) {
    sendJson(response, 400, { ok: false, error: "Chat ID atau username kanal tidak valid." });
    return;
  }

  try {
    await sendTelegramMessage(token, chatId);
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendJson(response, 502, { ok: false, error: error.message });
  }
}

function isPrivateIPv4(address) {
  const octets = address.split(".").map(Number);
  return net.isIPv4(address) && (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function isLocalDashboardRequest(request) {
  if (request.headers.host !== `${HOST}:${PORT}` && request.headers.host !== `localhost:${PORT}`) {
    return false;
  }
  const origin = request.headers.origin;
  return !origin || origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
}

function proxySensorApi(target, response) {
  let upstream;
  try {
    upstream = new URL(target);
  } catch {
    sendJson(response, 400, { ok: false, error: "URL API sensor tidak valid." });
    return;
  }
  if (
    upstream.protocol !== "http:" ||
    !isPrivateIPv4(upstream.hostname) ||
    (upstream.port && upstream.port !== "80") ||
    upstream.username ||
    upstream.password ||
    upstream.pathname !== "/api/sensors1" ||
    upstream.search ||
    upstream.hash
  ) {
    sendJson(response, 400, { ok: false, error: "Proxy hanya mengizinkan API sensor lokal pada /api/sensors1." });
    return;
  }

  const proxyRequest = http.get({
    hostname: upstream.hostname,
    port: 80,
    path: upstream.pathname,
    timeout: 5000,
    headers: { Accept: "application/json" }
  }, upstreamResponse => {
    const chunks = [];
    let size = 0;
    upstreamResponse.on("data", chunk => {
      size += chunk.length;
      if (size > 8192) {
        proxyRequest.destroy(new Error("Respons API sensor terlalu besar."));
        return;
      }
      chunks.push(chunk);
    });
    upstreamResponse.on("end", () => {
      response.writeHead(upstreamResponse.statusCode || 502, {
        "Content-Type": upstreamResponse.headers["content-type"] || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(Buffer.concat(chunks));
    });
  });
  proxyRequest.on("timeout", () => proxyRequest.destroy(new Error("Waktu koneksi ke sensor habis.")));
  proxyRequest.on("error", error => {
    if (response.headersSent) return;
    const message = error.message.includes("Waktu koneksi")
      ? error.message
      : error.message.includes("terlalu besar")
        ? error.message
        : "Tidak dapat menghubungi ESP8266. Periksa IP, Wi-Fi, dan endpoint API.";
    sendJson(response, 502, { ok: false, error: message });
  });
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${HOST}:${PORT}`);
  const pathname = requestUrl.pathname;
  if (pathname === "/api/telegram/test" && request.method === "POST") {
    handleTelegramTest(request, response);
    return;
  }
  if (pathname === "/api/sensor-proxy" && request.method === "GET") {
    if (!isLocalDashboardRequest(request)) {
      sendJson(response, 403, { ok: false, error: "Proxy sensor hanya dapat digunakan dari dashboard lokal." });
      return;
    }
    proxySensorApi(requestUrl.searchParams.get("url") || "", response);
    return;
  }
  if (pathname.startsWith("/api/")) {
    sendJson(response, 404, { ok: false, error: "Endpoint tidak ditemukan." });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { ok: false, error: "Metode tidak diizinkan." });
    return;
  }

  let filePath;
  try {
    filePath = path.resolve(WEB_ROOT, `.${decodeURIComponent(pathname)}`);
  } catch {
    sendJson(response, 400, { ok: false, error: "Alamat halaman tidak valid." });
    return;
  }
  if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + path.sep)) {
    sendJson(response, 403, { ok: false, error: "Akses ditolak." });
    return;
  }
  if (pathname.endsWith("/")) filePath = path.join(filePath, "index.html");

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, error.code === "ENOENT" ? 404 : 500, { ok: false, error: "Halaman tidak dapat dibuka." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(request.method === "HEAD" ? undefined : content);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard SIPATAR siap di http://${HOST}:${PORT}`);
  console.log("Tekan Ctrl+C untuk menghentikan server.");
});
