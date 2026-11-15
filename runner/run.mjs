// Один запуск облака (GitHub Actions, каждые 5 минут): расписание ставок всех задач — тот же код, что на Netlify
// (netlify/functions/bids-cron.mjs), затем копия фидов автозагрузки для GitHub Pages (feeds.mjs).
// В журнал GitHub (он публичный у открытого репозитория) не пишется ничего, кроме счётчиков.
import fs from "node:fs";
import path from "node:path";
import { load, save, deletedIds } from "./blobs.mjs";
import cron from "./netlify/functions/bids-cron.mjs";
import { mirrorFeeds } from "./feeds.mjs";

const t0 = Date.now();
if (!process.env.ATK_VAULT_KEY) {
  console.log("Не задан секрет ATK_VAULT_KEY — ставки не запускаю (Settings → Secrets and variables → Actions).");
} else {
  await load();
  try {
    await cron();
  } catch (e) {
    console.log("ставки: ошибка запуска —", String(e && e.message || e).slice(0, 120));
  }
  const n = await save();
  const jobs = process.env.ATK_JOBS_DIR || "jobs";
  for (const id of deletedIds()) {
    try { fs.unlinkSync(path.join(jobs, id + ".json")); } catch (e) { /* уже нет */ }
  }
  console.log(`ставки: записей обновлено ${n} за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
}
try {
  const r = await mirrorFeeds();
  console.log(`фиды: ${r.ok} из ${r.total} обновлены`);
} catch (e) {
  console.log("фиды: ошибка —", String(e && e.message || e).slice(0, 120));
}
