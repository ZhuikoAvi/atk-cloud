// Заменитель хранилища Netlify Blobs для запуска на GitHub Actions: те же getStore().get/setJSON/list/delete,
// но данные — файлы. Всё лежит в открытом репозитории ТОЛЬКО зашифрованным (AES-256-GCM, ключ — секрет
// репозитория ATK_VAULT_KEY), поэтому в репозитории не видно ни ключей Авито, ни ставок, ни названий объявлений.
//
//   jobs/<id>.json        — настройки задачи от программы: {name, sched, watch, enabled, keys, tg, force_at, delete}
//                           (пишет программа через GitHub API; шифрует тем же ключом, «доп. данные» — "cfg:<id>")
//   state/<ключ>.json     — рабочее состояние (сниженные ставки, очередь, журнал, снимки) — пишет этот запуск
//
// Задача для кода ставок (netlify/functions/bids-cron.mjs) собирается так: состояние + настройки поверх; ключи
// Авито и Telegram заново «запечатываются» в памяти — код открывает их как на Netlify (open(job.keys, "keys:"+id)).

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { seal, open } from "./netlify/lib/bids.mjs";

const JOBS = process.env.ATK_JOBS_DIR || path.join(process.cwd(), "jobs");     // ветка main
const STATE = process.env.ATK_STATE_DIR || path.join(process.cwd(), "state");  // ветка state
const CFG_FIELDS = ["name", "sched", "watch", "enabled"];

const mem = new Map();      // ключ → объект
const dirty = new Set();    // изменённые ключи
const gone = new Set();     // удалённые ключи
const cfgs = new Map();     // id → настройки задачи
let loaded = false;

// имя файла — хэш ключа: ключи бывают длинными (текст уведомления) — длинное имя роняло запись состояния
const fname = (key) => createHash("sha256").update(key).digest("hex").slice(0, 40) + ".json";

async function readBox(file, aad) {
  try {
    const box = JSON.parse(fs.readFileSync(file, "utf8"));
    return await open(box, aad);
  } catch (e) {
    return null;
  }
}

export async function load() {
  if (loaded) return;
  loaded = true;
  fs.mkdirSync(STATE, { recursive: true });
  // рабочее состояние: имя файла — хэш ключа; сам ключ (в нём бывает текст уведомления) — внутри шифра
  for (const f of fs.existsSync(STATE) ? fs.readdirSync(STATE) : []) {
    if (!f.endsWith(".json")) continue;
    try {
      const box = JSON.parse(fs.readFileSync(path.join(STATE, f), "utf8"));
      const { k, v } = await open(box, "state");
      if (k) mem.set(k, v);
    } catch (e) { /* испорчен или чужой ключ шифрования — пропуск */ }
  }
  // настройки задач от программы
  for (const f of fs.existsSync(JOBS) ? fs.readdirSync(JOBS) : []) {
    const id = f.replace(/\.json$/, "");
    if (!/^[a-f0-9]{16,64}$/.test(id)) continue;
    const cfg = await readBox(path.join(JOBS, f), "cfg:" + id);
    if (!cfg) continue;
    cfgs.set(id, cfg);
    const key = "job:" + id;
    const job = mem.get(key) || { created: new Date().toISOString(), state: "", saved: {}, queue: [], log: [], alerts: [] };
    if (job.deleted) continue;  // уже удалена — ждём, пока программа уберёт файл настроек
    for (const k of CFG_FIELDS) if (cfg[k] !== undefined) job[k] = cfg[k];
    if (cfg.keys && cfg.keys.client_id) {
      if (job.keys_sig !== cfg.keys.client_id) { job.state = ""; job.keys_sig = cfg.keys.client_id; }
      job.keys = await seal(cfg.keys, "keys:" + id);
    } else {
      delete job.keys;
    }
    job.tg = cfg.tg && cfg.tg.token && cfg.tg.chat ? await seal(cfg.tg, "tg:" + id) : null;
    if ((cfg.force_at || "") > (job.force_done || "")) job.force = true;
    if (cfg.delete && !job.delete_after) {  // программа выключила облако: вернуть сниженные ставки и удалить
      job.enabled = false;
      job.sched = { ...(job.sched || {}), on: false };
      job.delete_after = true;
      job.force = true;
    }
    mem.set(key, job);
  }
}

export function getStore() {
  return {
    async get(key) { await load(); return mem.has(key) ? structuredClone(mem.get(key)) : null; },
    async setJSON(key, val) {
      await load();
      mem.set(key, structuredClone(val));
      dirty.add(key);
      gone.delete(key);
    },
    async delete(key) {
      await load();
      if (key.startsWith("job:")) {  // задачу не стираем совсем — помечаем, чтобы программа увидела «удалена»
        mem.set(key, { deleted: true, last: new Date().toISOString() });
        dirty.add(key);
        return;
      }
      mem.delete(key);
      gone.add(key);
      dirty.delete(key);
    },
    async list({ prefix = "" } = {}) {
      await load();
      return { blobs: [...mem.keys()].filter((k) => k.startsWith(prefix) && !(mem.get(k) || {}).deleted)
        .map((key) => ({ key })) };
    },
  };
}

// задачи, которые код ставок удалил (вернул ставки) — их файлы настроек можно убрать из main
export function deletedIds() {
  return [...cfgs.keys()].filter((id) => (mem.get("job:" + id) || {}).deleted);
}

// записать изменения на диск (рабочий процесс потом коммитит папку state)
export async function save() {
  for (const key of dirty) {
    let val = mem.get(key);
    if (key.startsWith("job:")) {
      const id = key.slice(4);
      val = { ...val };
      delete val.keys;  // ключи — только в настройках от программы
      delete val.tg;
      if (!val.force && cfgs.get(id)) val.force_done = cfgs.get(id).force_at || val.force_done || "";
    }
    const box = await seal({ k: key, v: val }, "state");
    fs.writeFileSync(path.join(STATE, fname(key)), JSON.stringify(box));
  }
  for (const key of gone) {
    try { fs.unlinkSync(path.join(STATE, fname(key))); } catch (e) { /* уже нет */ }
  }
  return dirty.size + gone.size;
}
