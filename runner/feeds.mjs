// Копия фидов автозагрузки на GitHub Pages: https://<владелец>.github.io/<репозиторий>/feed/<id>.xml
// Программа пишет в feeds.json (ветка main) id файлов фидов в Google Диске; здесь каждый фид скачивается с Диска
// и кладётся в ветку pages как обычный XML. Отдаётся только файл, похожий на фид Авито (<Ads …>).
//
// ФОТО. В фиде ссылки на фото ведут на сайт zhuiko.pro (/ya/i/<ключ>.jpg — Яндекс.Диск, /g/<id>.jpg — Google Диск).
// Пока сайт недоступен, Авито публиковал бы объявления без фото. Поэтому в копии фида:
//   • фото Google Диска → прямая постоянная ссылка Google (lh3.googleusercontent.com/d/<id>=w1600);
//   • фото Яндекс.Диска → копия здесь же, в GitHub Pages (/ya/i/<ключ>.jpg): облако скачивает уменьшенную до
//     1600 px картинку (так меньше места) один раз и хранит. Объявления из фида НИКОГДА не убираются (Авито снял
//     бы их) — пока копии фото нет, остаётся прежняя ссылка; готовность — в status.json (сколько фото ждут).
import fs from "node:fs";
import path from "node:path";

const ID = /^[A-Za-z0-9_-]{20,80}$/;
const RX_YA = /https?:\/\/(?:www\.)?zhuiko\.pro\/ya\/i\/([A-Za-z0-9_-]{6,80})\.(?:jpe?g|png|webp)/gi;
const RX_G = /https?:\/\/(?:www\.)?zhuiko\.pro\/g\/([A-Za-z0-9_-]{10,80})\.(?:jpe?g|png|webp)/gi;
const PHOTO_BUDGET_MS = +(process.env.ATK_PHOTO_BUDGET_MS || 300000);  // качать фото не дольше 5 минут за запуск
const UA = { "User-Agent": "Mozilla/5.0 (atk-cloud photo)" };

function kind(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length > 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return "";
}

async function yaPhoto(key) {
  const pub = encodeURIComponent("https://disk.yandex.ru/i/" + key);
  // 1) уменьшенная картинка (превью 1600 px по длинной стороне) — в 5–10 раз меньше оригинала
  try {
    const r = await fetch(`https://cloud-api.yandex.net/v1/disk/public/resources?public_key=${pub}` +
      "&preview_size=1600x&preview_crop=false&fields=preview,size,media_type", { headers: UA });
    if (r.status === 404) return null;
    if (r.ok) {
      const j = await r.json();
      if (j.preview) {
        const p = await fetch(j.preview, { headers: UA, redirect: "follow" });
        if (p.ok) {
          const b = new Uint8Array(await p.arrayBuffer());
          if (kind(b) && b.length > 2000) return b;
        }
      }
    }
  } catch (e) { /* ниже — оригинал */ }
  // 2) оригинал (если превью не дали), не больше 8 МБ
  try {
    const r = await fetch(`https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=${pub}`,
      { headers: UA });
    if (!r.ok) return null;
    const href = (await r.json()).href;
    if (!href) return null;
    const p = await fetch(href, { headers: UA, redirect: "follow" });
    if (!p.ok) return null;
    const b = new Uint8Array(await p.arrayBuffer());
    return kind(b) && b.length < 8 * 1024 * 1024 ? b : null;
  } catch (e) {
    return null;
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export async function mirrorFeeds() {
  const list = process.env.ATK_FEEDS_LIST || "feeds.json";
  const out = process.env.ATK_PAGES_DIR || "pages";
  const base = (process.env.ATK_PAGES_BASE || "").replace(/\/+$/, "");
  let ids = [];
  try { ids = JSON.parse(fs.readFileSync(list, "utf8")).feeds || []; } catch (e) { return { ok: 0, total: 0 }; }
  ids = [...new Set(ids.filter((x) => ID.test(String(x))))];
  fs.mkdirSync(path.join(out, "feed"), { recursive: true });
  fs.mkdirSync(path.join(out, "ya", "i"), { recursive: true });
  fs.writeFileSync(path.join(out, ".nojekyll"), "");
  if (!fs.existsSync(path.join(out, "index.html")))
    fs.writeFileSync(path.join(out, "index.html"), "<!doctype html><meta charset=utf-8><title>Avito Toolkit</title>" +
      "<p>Резервные копии фидов автозагрузки Avito Toolkit Pro.</p>");
  const have = new Set(fs.readdirSync(path.join(out, "ya", "i")).map((f) => f.replace(/\.[a-z]+$/, "")));
  const feeds = [];
  const need = new Set();
  for (const id of ids) {
    try {
      const r = await fetch(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
        { redirect: "follow", headers: UA });
      if (!r.ok) continue;
      const xml = await r.text();
      if (!/<Ads[\s>]/i.test(xml.slice(0, 4096))) continue;  // не фид (закрыт доступ / страница Google)
      for (const m of xml.matchAll(RX_YA)) if (!have.has(m[1])) need.add(m[1]);
      feeds.push([id, xml]);
    } catch (e) { /* следующий запуск попробует снова */ }
  }
  // недостающие фото — по 8 параллельно, не дольше PHOTO_BUDGET_MS (остальные — в следующий запуск)
  let got = 0;
  const t0 = Date.now();
  const todo = [...need];
  await pool(todo, 8, async (key) => {
    if (Date.now() - t0 > PHOTO_BUDGET_MS) return;
    const b = await yaPhoto(key);
    if (!b) return;
    fs.writeFileSync(path.join(out, "ya", "i", key + "." + kind(b)), b);
    have.add(key);
    got++;
  });
  let ok = 0;
  const exts = new Map(fs.readdirSync(path.join(out, "ya", "i")).map((f) => [f.replace(/\.[a-z]+$/, ""), f]));
  for (const [id, xml0] of feeds) {
    const xml = xml0
      .replace(RX_G, (_m, gid) => `https://lh3.googleusercontent.com/d/${gid}=w1600`)
      .replace(RX_YA, (m, key) => (base && exts.has(key) ? `${base}/ya/i/${exts.get(key)}` : m));
    fs.writeFileSync(path.join(out, "feed", id + ".xml"), xml);
    ok++;
  }
  for (const f of fs.readdirSync(path.join(out, "feed"))) {  // фиды, которых больше нет в списке, — убрать
    if (!ids.includes(f.replace(/\.xml$/, ""))) fs.unlinkSync(path.join(out, "feed", f));
  }
  const waiting = need.size - got;
  // status.json — только когда что-то изменилось: каждая запись в ветку pages — это сборка GitHub Pages, а их
  // разрешено около 10 в час (облако делает проход каждые 5 минут)
  const sp = path.join(out, "status.json");
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(sp, "utf8")); } catch (e) { /* нет — запишем */ }
  if (prev.feeds !== ok || prev.photos !== exts.size || prev.waiting !== waiting)
    fs.writeFileSync(sp, JSON.stringify({ feeds: ok, photos: exts.size, waiting, at: new Date().toISOString() }));
  return { ok, total: ids.length, photos: got, waiting };
}
