"use strict";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body)
  };
}

function isSameOrigin(event) {
  const origin = event.headers.origin || event.headers.Origin;
  const host = event.headers.host || event.headers.Host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") {
    return respond(405, { ok: false, error: "Metode tidak diizinkan." });
  }
  if (!isSameOrigin(event)) {
    return respond(403, { ok: false, error: "Permintaan harus berasal dari dashboard." });
  }
  if (!(event.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    return respond(415, { ok: false, error: "Format permintaan harus JSON." });
  }

  let payload;
  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "";
    if (Buffer.byteLength(rawBody, "utf8") > 4096) {
      return respond(413, { ok: false, error: "Ukuran permintaan terlalu besar." });
    }
    payload = JSON.parse(rawBody);
  } catch {
    return respond(400, { ok: false, error: "Format permintaan tidak valid." });
  }

  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  const chatId = typeof payload.chatId === "string" ? payload.chatId.trim() : "";
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    return respond(400, { ok: false, error: "Format Bot token tidak valid. Salin token dari BotFather." });
  }
  if (!chatId || chatId.length > 128) {
    return respond(400, { ok: false, error: "Chat ID atau username kanal tidak valid." });
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "[SIPATAR] Pesan uji berhasil. Koneksi bot dan Chat ID aktif."
      }),
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      return respond(502, {
        ok: false,
        error: result.description || `Telegram merespons HTTP ${response.status}.`
      });
    }
    return respond(200, { ok: true });
  } catch (error) {
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    return respond(502, {
      ok: false,
      error: timedOut ? "Waktu koneksi ke Telegram habis." : "Tidak dapat terhubung ke Telegram."
    });
  }
};
