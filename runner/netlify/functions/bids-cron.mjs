// Облачное расписание ставок — запускается Netlify каждые 5 минут (даже когда компьютер выключен).
// Экономно: задача читается и записывается в хранилище, только если ей что-то пора делать.
// За один запуск: не дольше ~24 секунд (лимит Netlify — 30 с) и не больше ~6 изменений ставок на аккаунт
// (Авито принимает до 20 изменений в минуту).
//   • каждые 15 минут (или сразу после изменения настроек) — проверить окно расписания: вне окна ставки
//     запоминаются и ставятся в очередь на снижение/отключение, в начале окна — в очередь на возврат;
//   • каждые 30 минут — расход дневного лимита ручных ставок (уведомление в Telegram и в программу);
//   • раз в час — снимок расходов/просмотров/контактов по объявлениям для «Активности по часам» (если включено),
//     хранится 15 дней в snap:<задача>:<день>, программа забирает их и дописывает к своим.

import { store, open, msk, inWindow, dayWin, avitoToken, api, activeItems, promotions, tgSend, sleep, pushLog } from "../lib/bids.mjs";

const BUDGET_MS = 24000;

export default async () => {
  const t0 = Date.now();
  if (!process.env.ATK_VAULT_KEY) return;
  const st = store();
  const { blobs: all } = await st.list({ prefix: "job:" });
  // по кругу: если за минуту не успеем все задачи, на следующей минуте начнём с других
  const k = all.length ? Math.floor(Date.now() / 60000) % all.length : 0;
  const blobs = all.slice(k).concat(all.slice(0, k));
  for (const bl of blobs) {
    if (Date.now() - t0 > BUDGET_MS - 4000) break;
    const id = bl.key.slice(4);
    let job = await st.get(bl.key, { type: "json" });
    if (!job) continue;
    let did = false;
    try {
      did = await runJob(id, job, t0);
    } catch (e) {
      pushLog(job, "err", String(e.message || e));
      did = true;
    }
    if (!did && !job.delete_after) continue;  // ничего не делали — не пишем (экономия запросов к хранилищу)
    job.last = new Date().toISOString();
    if (job.delete_after && !Object.keys(job.saved || {}).length && !(job.queue || []).length) {
      await st.delete(bl.key);
    } else {
      await st.setJSON(bl.key, job);
    }
  }
};

async function runJob(id, job, t0) {
  const now = Date.now();
  const sc = job.sched || {};
  const t = msk(now);
  const due = job.force || !job.checked || now - Date.parse(job.checked) > 14 * 60000;
  const burnDue = job.enabled !== false && sc.burn !== false && (!job.burn_at || now - Date.parse(job.burn_at) > 29 * 60000);
  const w = job.watch || null;
  const watchDue = job.enabled !== false && w && (w.rej || w.adv) &&
    (!job.watch_at || now - Date.parse(job.watch_at) > 29 * 60000);
  const hourKey = t.day + "T" + t.hhmm.slice(0, 2);
  const snapDue = job.enabled !== false && w && w.snap && job.snap_h !== hourKey;
  if (!due && !burnDue && !watchDue && !snapDue && !(job.queue || []).length) return false;
  if (!job.keys) return false;
  const keys = await open(job.keys, "keys:" + id);
  let tok = null;
  const token = async () => (tok = tok || await avitoToken(keys));
  // скрытый в программе аккаунт (клиент ушёл) — ставки по расписанию идут, но в Telegram не пишем
  const tg = job.tg && !(w && w.mute) ? await open(job.tg, "tg:" + id).catch(() => null) : null;

  // ---------------- окно расписания
  if (due) {
    job.force = false;
    job.checked = new Date().toISOString();
    const active = job.enabled !== false && sc.on;
    const want = active && !inWindow(sc, t) ? "out" : "in";
    if (want !== job.state) {
      if (want === "out") {
        const items = await activeItems(await token());
        const pr = await promotions(await token(), items.map((i) => i.id));
        job.saved = job.saved || {};
        let n = 0;
        for (const it of items) {
          const man = (pr[it.id] || {}).manualPromotion;
          if (!man || !man.bidPenny) continue;
          if (!job.saved[it.id]) job.saved[it.id] = { bid: man.bidPenny, limit: man.limitPenny || null,
                                                      action: (pr[it.id] || {}).actionTypeID || 7, title: it.title };
          job.queue.push({ id: it.id, op: sc.out });
          n++;
        }
        pushLog(job, "info", `${t.hhmm} — вне расписания: ставок к ${{ off: "отключению", min: "минимальной",
          pct: `снижению до ${sc.pct} %` }[sc.out]} — ${n}`);
        if (n) await tgSend(tg, `⏰ ${job.name || "Ставки"}: вне расписания — ${n} ставок ${sc.out === "off" ?
          "отключаются" : "снижаются"}, вернутся в начале окна.`);
      } else {
        const ids = Object.keys(job.saved || {});
        job.queue = (job.queue || []).filter((q) => q.op === "restore");
        for (const i of ids) job.queue.push({ id: +i, op: "restore" });
        if (ids.length) {
          pushLog(job, "info", `${t.hhmm} — начало окна: возвращаю ставки — ${ids.length}`);
          await tgSend(tg, `⏰ ${job.name || "Ставки"}: начало рабочего окна — возвращаю ${ids.length} ставок.`);
        }
      }
      job.state = want;
    } else if (want === "in" && Object.keys(job.saved || {}).length &&
               !(job.queue || []).some((q) => q.op === "restore")) {
      // окно уже идёт, а часть ставок так и не вернулась (сбой при возврате) — ставим их на возврат снова
      const ids = Object.keys(job.saved);
      job.queue = (job.queue || []).concat(ids.map((i) => ({ id: +i, op: "restore" })));
      pushLog(job, "info", `${t.hhmm} — не вернулись ставки: ${ids.length} — возвращаю снова`);
    }
  }

  // ---------------- очередь изменений (не больше ~6 за запуск)
  let done = 0;
  while ((job.queue || []).length && done < 7 && Date.now() - t0 < BUDGET_MS - 5000) {
    const q = job.queue.shift();
    const sv = (job.saved || {})[q.id];
    if (!sv) continue;
    try {
      if (q.op === "restore") {
        const body = { itemID: q.id, bidPenny: sv.bid, actionTypeID: sv.action || 7 };
        if (sv.limit) body.limitPenny = sv.limit;
        await api(await token(), "POST", "/cpxpromo/1/setManual", body);
        delete job.saved[q.id];
      } else if (q.op === "off") {
        await api(await token(), "POST", "/cpxpromo/1/remove", { itemID: q.id });
      } else {
        let bid;
        if (q.op === "min") {
          const b = await api(await token(), "GET", `/cpxpromo/1/getBids/${q.id}`).catch(() => ({}));
          bid = ((b.manual || {}).minBidPenny) || Math.round(sv.bid * 0.3 / 100) * 100;
        } else {
          bid = Math.max(100, Math.round(sv.bid * (job.sched.pct || 30) / 100 / 100) * 100);
        }
        if (bid < sv.bid) {
          const body = { itemID: q.id, bidPenny: bid, actionTypeID: sv.action || 7 };
          if (sv.limit) body.limitPenny = sv.limit;
          await api(await token(), "POST", "/cpxpromo/1/setManual", body);
        }
      }
    } catch (e) {
      if (e.code === 429) { job.queue.unshift(q); break; }  // лимит Авито — продолжим через минуту
      // сеть («fetch failed») или сбой на стороне Авито (5xx) — ставку не теряем: вернём в очередь и попробуем
      // в следующий запуск (до 30 раз ≈ 2,5 часа). Раньше такая ставка выпадала из очереди и не возвращалась.
      if (e.net || (e.code >= 500 && e.code < 600)) {
        q.tries = (q.tries || 0) + 1;
        if (q.tries <= 30) {
          job.queue.unshift(q);
          pushLog(job, "warn", `${q.id}: Авито не ответил — повторю через 5 минут (${q.tries})`);
          break;
        }
      }
      pushLog(job, "err", `${q.id}: ${String(e.message || e).slice(0, 140)}`);
      // Авито отказал по существу (объявление снято, ставка не принимается) — больше не пытаемся вернуть её
      if (q.op === "restore" && job.saved) delete job.saved[q.id];
    }
    done++;
    await sleep(3100);
  }
  if (done && !job.queue.length) pushLog(job, "ok", "Очередь ставок выполнена");

  // ---------------- отклонённые / заблокированные и аванс — раз в 30 минут
  if (watchDue && Date.now() - t0 < BUDGET_MS - 6000) {
    job.watch_at = new Date().toISOString();
    try { await watch(job, await token(), t, tg); } catch (e) { pushLog(job, e.net ? "warn" : "err", "Проверка аккаунта: " + e.message); }
  }

  // ---------------- расход дневного лимита
  let statsUsed = false;
  if (burnDue && Date.now() - t0 < BUDGET_MS - 6000) {
    job.burn_at = new Date().toISOString();
    try { statsUsed = await burn(job, await token(), t, tg); } catch (e) { pushLog(job, e.net ? "warn" : "err", "Расход лимита: " + e.message); }
  }

  // ---------------- снимок для «Активности по часам» (статистика Авито — не чаще раза в минуту, поэтому
  // если в этот запуск её уже брал «расход лимита», снимок — на следующем, через 5 минут)
  if (snapDue && !statsUsed && Date.now() - t0 < BUDGET_MS - 6000) {
    try {
      await snap(id, await token(), t);
      job.snap_h = hourKey;
    } catch (e) {
      if (e.code !== 429) { pushLog(job, "err", "Снимок активности: " + String(e.message || e).slice(0, 140)); job.snap_h = hourKey; }
    }
  }
  return true;
}

async function snap(id, tok, t) {
  const me = await api(tok, "GET", "/core/v1/accounts/self");
  const items = {};
  for (let off = 0, p = 0; p < 10; p++, off += 1000) {
    const j = await api(tok, "POST", `/stats/v2/accounts/${me.id}/items`, {
      dateFrom: t.day, dateTo: t.day, metrics: ["allSpending", "views", "contacts"], grouping: "item", limit: 1000, offset: off });
    const g = (j.result || j).groupings || [];
    for (const x of g) {
      const v = { allSpending: 0, views: 0, contacts: 0 };
      for (const m of x.metrics || []) if (m.slug in v) v[m.slug] = +m.value || 0;
      const row = [Math.round(v.allSpending) / 100, v.views, v.contacts];  // расход — в рублях, как в программе
      if (row.some((n) => n)) items[String(x.id)] = row;
    }
    if (g.length < 1000) break;
  }
  const st = store();
  const key = `snap:${id}:${t.day}`;
  const d = (await st.get(key, { type: "json" })) || { day: t.day, snaps: [] };
  d.snaps = (d.snaps || []).filter((s) => s.t !== t.hhmm);
  d.snaps.push({ t: t.hhmm, i: items });
  await st.setJSON(key, d);
  if (t.hhmm < "01:00") {  // раз в сутки — убрать снимки старше 15 дней
    const old = new Date(Date.parse(t.day) - 15 * 86400000).toISOString().slice(0, 10);
    const { blobs } = await st.list({ prefix: `snap:${id}:` });
    for (const b of blobs) if (b.key.slice(-10) < old) await st.delete(b.key);
  }
}

async function watch(job, tok, t, tg) {
  const w = job.watch || {};
  const name = job.name || "Аккаунт";
  const note = (text) => { job.alerts = (job.alerts || []).slice(-50); job.alerts.push({ at: new Date().toISOString(), text }); };
  if (w.rej) {
    let n = 0;
    for (let p = 1; p <= 10; p++) {
      const j = await api(tok, "GET", `/core/v1/items?per_page=100&page=${p}&status=rejected,blocked`);
      const part = j.resources || [];
      n += part.length;
      if (part.length < 100) break;
    }
    const prev = job.rej_n === undefined ? null : job.rej_n;
    if (prev !== null && n > prev) {
      const text = `⚠ ${name}: отклонено/заблокировано: ${n} (+${n - prev})`;
      note(text);
      await tgSend(tg, text);
    }
    job.rej_n = n;
  }
  if (w.adv) {
    let bal = null;
    for (const path of ["/cpa/v3/balanceInfo", "/cpa/v2/balanceInfo"]) {
      try {
        const j = await api(tok, "POST", path, {});
        const v = j.balance !== undefined ? j.balance : (j.result || {}).balance;
        if (typeof v === "number") { bal = v / 100; break; }
      } catch (e) { /* другой путь */ }
    }
    if (bal !== null) {
      const fmt = (x) => Math.round(x).toLocaleString("ru-RU");
      const hide = w.adv_hide || 0;
      const zero = bal <= Math.max(0, hide);
      const sixh = 6 * 3600000;
      if (zero && (!job.adv_zero_at || Date.now() - Date.parse(job.adv_zero_at) > sixh)) {
        const text = `💸 ${name}: аванс закончился (${fmt(bal)} ₽) — объявления не показываются в выдаче, пополните`;
        job.adv_zero_at = new Date().toISOString();
        note(text);
        await tgSend(tg, text);
      } else if (!zero && job.adv_zero_at) {
        const text = `✅ ${name}: аванс пополнен (${fmt(bal)} ₽) — показы вернулись`;
        job.adv_zero_at = null;
        note(text);
        await tgSend(tg, text);
      }
      if (!zero && w.adv_min && bal < w.adv_min && job.adv_low_day !== t.day) {
        const text = `💸 ${name}: аванс ${fmt(bal)} ₽ — меньше порога ${fmt(w.adv_min)} ₽`;
        job.adv_low_day = t.day;
        note(text);
        await tgSend(tg, text);
      }
      job.adv_last = bal;
    }
  }
}

async function burn(job, tok, t, tg) {
  const sc = job.sched || {};
  const items = await activeItems(tok);
  const pr = await promotions(tok, items.map((i) => i.id));
  const lim = items.filter((i) => ((pr[i.id] || {}).manualPromotion || {}).limitPenny);
  if (!lim.length) return false;
  const me = await api(tok, "GET", "/core/v1/accounts/self");
  const j = await api(tok, "POST", `/stats/v2/accounts/${me.id}/items`, {
    dateFrom: t.day, dateTo: t.day, metrics: ["allSpending"], grouping: "item", limit: 1000, offset: 0 });
  const spent = {};
  for (const g of ((j.result || j).groupings || [])) {
    const m = (g.metrics || []).find((x) => x.slug === "allSpending");
    spent[+g.id] = m ? +m.value : 0;  // в копейках
  }
  const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "")); return m ? +m[1] * 60 + +m[2] : 0; };
  const [wf, wt] = dayWin(sc, t.wd);
  const a = sc.on ? hm(wf) : 0, b = sc.on ? hm(wt) : 1440;
  const span = b > a ? b - a : 1440;
  const passed = b > a ? Math.min(1, Math.max(0.02, (t.min - a) / span)) : 0.5;
  job.burn_sent = Object.fromEntries(Object.entries(job.burn_sent || {}).filter(([, d]) => d === t.day));
  const lines = [];
  for (const it of lim) {
    const L = pr[it.id].manualPromotion.limitPenny;
    const s = spent[it.id] || 0;
    const share = s / L;
    if (share < 0.3) continue;
    if (!(share >= (sc.burn_pct || 80) / 100 || share > passed * 1.5)) continue;
    if (job.burn_sent[it.id] === t.day) continue;
    job.burn_sent[it.id] = t.day;
    const rub = (k) => Math.round(k / 100).toLocaleString("ru-RU");
    const line = `${it.title.slice(0, 50)}: к ${t.hhmm} потрачено ${Math.round(share * 100)} % дневного лимита ` +
      `(${rub(s)} из ${rub(L)} ₽)` + (share >= 1 ? " — лимит исчерпан" : "");
    lines.push(line);
    job.alerts = (job.alerts || []).slice(-50);
    job.alerts.push({ at: new Date().toISOString(), text: line });
  }
  if (lines.length) {
    pushLog(job, "warn", `Быстрый расход лимита: ${lines.length}`);
    await tgSend(tg, `🔥 ${job.name || "Ставки"}: лимит расходуется быстро\n• ` + lines.join("\n• "));
  }
  return true;
}

export const config = { schedule: "*/5 * * * *" };
