// Общее для облачного расписания ставок: шифрование ключей, хранилище, работа с API Авито.
//
// БЕЗОПАСНОСТЬ
// • Ключи API Авито (client_id/client_secret) и токен Telegram шифруются AES-256-GCM ключом из переменной
//   окружения Netlify ATK_VAULT_KEY и в хранилище лежат только зашифрованными. Ключа шифрования нет ни в коде,
//   ни в программе, ни в хранилище.
// • Ни один запрос не возвращает ключи обратно — их можно только записать, заменить или удалить.
// • Доступ к задаче — по секретному токену, который знает только программа; на сервере хранится лишь его SHA-256.

import { getStore } from "../../blobs.mjs";  // хранилище — файлы в ветке state (см. runner/blobs.mjs)

export const store = () => getStore({ name: "atk-bids", consistency: "strong" });

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => Buffer.from(u8).toString("base64");
const ub64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

async function vaultKey() {
  const raw = process.env.ATK_VAULT_KEY;
  if (!raw || raw.length < 24) throw new Error("server_not_configured: не задан ATK_VAULT_KEY (24+ символов)");
  const h = await crypto.subtle.digest("SHA-256", enc.encode(raw));
  return crypto.subtle.importKey("raw", h, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(obj, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await vaultKey(),
    enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

export async function open(box, aad) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(box.iv), additionalData: enc.encode(aad) },
    await vaultKey(), ub64(box.ct));
  return JSON.parse(dec.decode(pt));
}

export async function sha256(s) {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(String(s)));
  return Buffer.from(h).toString("hex");
}

export function same(a, b) {  // сравнение без утечки по времени
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ------------------------------------------------------------------ время (Москва, без перехода на летнее)
export function msk(now = Date.now(), offsetMin = 180) {
  const d = new Date(now + offsetMin * 60000);
  return { wd: (d.getUTCDay() + 6) % 7, min: d.getUTCHours() * 60 + d.getUTCMinutes(),
           day: d.toISOString().slice(0, 10), hhmm: d.toISOString().slice(11, 16) };
}

const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "")); return m ? (+m[1]) * 60 + (+m[2]) : 0; };

export function dayWin(sc, wd) {
  const v = sc.per && sc.per[String(wd)];
  return Array.isArray(v) && v.length === 2 ? v : [sc.from, sc.to];
}

export function inWindow(sc, t) {
  const days = sc.days || [];
  if (days.includes(t.wd)) {
    const [f, e] = dayWin(sc, t.wd), a = hm(f), b = hm(e);
    if ((a <= b && t.min >= a && t.min < b) || (a > b && t.min >= a)) return true;
  }
  const y = (t.wd + 6) % 7;
  if (days.includes(y)) {
    const [f, e] = dayWin(sc, y), a = hm(f), b = hm(e);
    if (a > b && t.min < b) return true;
  }
  return false;
}

// ------------------------------------------------------------------ API Авито
const API = "https://api.avito.ru";

// Связь облака с Авито иногда обрывается («fetch failed»: сеть, TLS, таймаут) — повторяем 3 раза с паузой,
// а потом пишем понятную причину вместо «fetch failed»
async function fetchRetry(url, opt, tries = 3) {
  let last;
  for (let k = 0; k < tries; k++) {
    try {
      return await fetch(url, { ...opt, signal: AbortSignal.timeout(12000) });
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * (k + 1)));
    }
  }
  const why = String((last && last.cause && (last.cause.code || last.cause.message)) || (last && last.message) || "");
  const err = new Error("Авито не ответил облаку (сеть" + (why && why !== "fetch failed" ? ": " + why : "") +
    ") — повторю в следующую проверку сам");
  err.net = true;
  throw err;
}

export async function avitoToken(keys) {
  const r = await fetchRetry(API + "/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "AvitoToolkitPro-cloud" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: keys.client_id,
                                client_secret: keys.client_secret }).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error("Авито не выдал доступ по ключам (" + r.status + ")");
  return j.access_token;
}

export async function api(tok, method, path, body) {
  const r = await fetchRetry(API + path, {
    method,
    headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json", "User-Agent": "AvitoToolkitPro-cloud" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) {
    const e = new Error(`Авито ${r.status}: ${t.slice(0, 160)}`);
    e.code = r.status;
    throw e;
  }
  return t ? JSON.parse(t) : {};
}

export async function activeItems(tok) {
  const out = [];
  for (let p = 1; p <= 50; p++) {
    const j = await api(tok, "GET", `/core/v1/items?per_page=100&page=${p}&status=active`);
    const part = j.resources || [];
    for (const it of part) out.push({ id: +it.id, title: it.title || "" });
    if (part.length < 100) break;
  }
  return out;
}

export async function promotions(tok, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 200) {
    const j = await api(tok, "POST", "/cpxpromo/1/getPromotionsByItemIds", { itemIDs: ids.slice(i, i + 200) });
    for (const it of j.items || []) out[+it.itemID] = it;
  }
  return out;
}

// одно и то же уведомление в тот же чат — не чаще раза в 20 минут: если у аккаунта две облачные задачи (программа
// подключала облако с двух компьютеров) или запуск оборвался до сохранения, «начало окна» приходило 2–3 раза
const _sent = new Map();
async function seenRecently(chat, text) {
  const key = "tgdup:" + String(chat) + ":" + text.replace(/\d+/g, "#").slice(0, 160);
  const now = Date.now();
  if ((_sent.get(key) || 0) > now - 20 * 60000) return true;
  _sent.set(key, now);
  try {
    const st = store();
    const prev = await st.get(key, { type: "json" }).catch(() => null);
    if (prev && prev.at > now - 20 * 60000) return true;
    await st.setJSON(key, { at: now });
  } catch (e) { /* хранилище недоступно — хватит памяти процесса */ }
  return false;
}

export async function tgSend(tg, text) {
  if (!tg || !tg.token || !tg.chat) return;
  if (await seenRecently(tg.chat, text)) return;
  try {
    await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chat, text: text.slice(0, 3900), disable_web_page_preview: true }),
    });
  } catch (e) { /* уведомление — не главное */ }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pushLog(job, kind, text) {
  job.log = (job.log || []).slice(-60);
  job.log.push({ at: new Date().toISOString(), kind, text: String(text).slice(0, 300) });
}
