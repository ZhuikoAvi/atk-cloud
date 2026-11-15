// Копия фидов автозагрузки на GitHub Pages: https://<владелец>.github.io/<репозиторий>/feed/<id>.xml
// Программа пишет в feeds.json (ветка main) id файлов фидов в Google Диске; здесь каждый фид скачивается с Диска
// и кладётся в папку ветки pages как обычный XML. Отдаётся только файл, похожий на фид Авито (<Ads …>).
import fs from "node:fs";
import path from "node:path";

const ID = /^[A-Za-z0-9_-]{20,80}$/;

export async function mirrorFeeds() {
  const list = process.env.ATK_FEEDS_LIST || "feeds.json";
  const out = process.env.ATK_PAGES_DIR || "pages";
  let ids = [];
  try { ids = JSON.parse(fs.readFileSync(list, "utf8")).feeds || []; } catch (e) { return { ok: 0, total: 0 }; }
  ids = [...new Set(ids.filter((x) => ID.test(String(x))))];
  fs.mkdirSync(path.join(out, "feed"), { recursive: true });
  fs.writeFileSync(path.join(out, ".nojekyll"), "");
  if (!fs.existsSync(path.join(out, "index.html")))
    fs.writeFileSync(path.join(out, "index.html"), "<!doctype html><meta charset=utf-8><title>Avito Toolkit</title>" +
      "<p>Резервные копии фидов автозагрузки Avito Toolkit Pro.</p>");
  let ok = 0;
  for (const id of ids) {
    try {
      const r = await fetch(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
        { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (atk-cloud feed)" } });
      if (!r.ok) continue;
      const xml = await r.text();
      if (!/<Ads[\s>]/i.test(xml.slice(0, 4096))) continue;  // не фид (закрыт доступ / страница Google) — старую копию не трогаем
      fs.writeFileSync(path.join(out, "feed", id + ".xml"), xml);
      ok++;
    } catch (e) { /* следующий запуск попробует снова */ }
  }
  // фиды, которых больше нет в списке, — убрать
  for (const f of fs.readdirSync(path.join(out, "feed"))) {
    if (!ids.includes(f.replace(/\.xml$/, ""))) fs.unlinkSync(path.join(out, "feed", f));
  }
  return { ok, total: ids.length };
}
