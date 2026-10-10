// War Ledger sync worker — records member statuses 24/7 for Torn ranked wars.
//
// It wakes every 2 minutes (cron), finds your active ranked war automatically,
// samples both factions' member statuses, detects enemy med-outs, and stores
// compact history in Workers KV. The tracker page reads it back via /snaps.
//
// Setup (Cloudflare dashboard, free plan):
//   1. KV: create a namespace (any name).
//   2. Worker: create, paste this file, Deploy.
//   3. Settings → Bindings → add KV namespace, variable name: LEDGER
//   4. Settings → Variables & Secrets → add secrets:
//        TORN_API_KEY   = your Limited key (needs faction API access)
//        TRACKER_TOKEN  = any password you invent (shared with the page)
//   5. Settings → Trigger Events → add Cron: */2 * * * *    (every 2 minutes —
//      keep it at 2, not 1: the free KV tier allows 1,000 writes/day)
//   6. Put the worker URL + token into the tracker page's settings drawer.

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env)); },

  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json"
    };
    if (req.method === "OPTIONS")
      return new Response(null, { headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "*"
      }});
    const tok = url.searchParams.get("token");
    const isAdmin = !env.TRACKER_TOKEN || tok === env.TRACKER_TOKEN;
    const isGames = env.GAMES_TOKEN && tok === env.GAMES_TOKEN;

    // Training leaderboard. Members post their own battle-stat total from their
    // own key — nobody can read anyone else's — and only the percentage gained
    // is ever served back, never the totals themselves.
    if (url.pathname.endsWith("/train")) {
      if (!isAdmin && !isGames) return json({ error: "bad or missing token" }, 403, cors);
      const key = "train";
      let doc = migrate((await env.LEDGER.get(key, "json"))) || { events: [], readers: {}, armLog: [], armIds: [], armCur: 0 };
      doc.events = doc.events || []; doc.readers = doc.readers || {};
      const now = Math.floor(Date.now() / 1000);
      const save = () => env.LEDGER.put(key, JSON.stringify(doc));

      // Opening an event ADDS one. Several can run at once — they share the
      // reading pass, so a second event costs no extra calls for members
      // already in the first.
      if (url.searchParams.has("set") || url.searchParams.has("reset")) {
        if (!isAdmin) return json({ error: "leaders only" }, 403, cors);
        const from = +url.searchParams.get("from") || now;
        const to = +url.searchParams.get("to") || (from + 2 * 86400);
        if (to <= from) return json({ error: "the end must be after the start" }, 400, cors);
        const ev = { id: String(from) + "-" + Math.random().toString(36).slice(2, 6),
                     name: (url.searchParams.get("name") || "").slice(0, NAME_MAX),
                     from, to, users: {}, locked: false, archived: false, keyTest: null,
                     prizes: readPrizes(url), roster: {} };
        doc.events.push(ev);
        doc.nextPoll = 0;
        await save();
        return json({ ok: true, event: ev }, 200, cors);
      }

      // Change a running event without clearing it.
      if (url.searchParams.has("edit")) {
        if (!isAdmin) return json({ error: "leaders only" }, 403, cors);
        const ev = evOf(doc, url.searchParams.get("ev")) || doc.events[0];
        if (!ev) return json({ error: "there is no event to edit" }, 400, cors);
        if (url.searchParams.has("name")) ev.name = (url.searchParams.get("name") || "").slice(0, NAME_MAX);
        if (url.searchParams.has("prizes")) ev.prizes = readPrizes(url);   // "prizes=1" means these are the prizes
        if (url.searchParams.has("to")) {
          const to = +url.searchParams.get("to") || 0;
          if (to <= ev.from) return json({ error: "the end must be after the start" }, 400, cors);
          ev.to = to;
          if (to > now) { ev.locked = false; ev.archived = false }     // reopened: let it record again
        }
        if (url.searchParams.has("from")) {
          const from = +url.searchParams.get("from") || 0;
          // Moving the start of a running event would silently redefine what
          // everyone's baseline means, so it is only allowed before it opens.
          if (now >= ev.from) return json({ error: "it has already started — the start can't move now" }, 400, cors);
          if (from >= ev.to) return json({ error: "the start must be before the end" }, 400, cors);
          ev.from = from; ev.keyTest = null;
        }
        doc.nextPoll = 0;
        await save();
        return json({ ok: true, event: ev }, 200, cors);
      }

      if (url.searchParams.has("close")) {          // leaders: bank an event and take it off the page
        if (!isAdmin) return json({ error: "leaders only" }, 403, cors);
        const ev = evOf(doc, url.searchParams.get("close"));
        if (!ev) return json({ error: "no such event" }, 404, cors);
        // Always re-bank, never trust the snapshot taken when it ended. That one
        // was written the moment the clock ran out; members have been added from
        // their logs since, and the scoring curve has been corrected. Closing is
        // the deliberate "this is the final word" action, so it should mean it.
        const banked = await archiveEvent(env, doc, ev);
        doc.events = doc.events.filter(e => e !== ev);
        await save();
        return json({ ok: true, banked }, 200, cors);
      }

      /* Backfill a finished event from the logs of members who only shared their
         gym log afterwards. The normal reading pass skips locked events — there
         is nothing left to sample — but a log reaches backwards, so somebody who
         connected a log key after the close can still have their real baseline,
         curve and energy recovered. One call per member, on a button. */
      /* Hold a result back. The scoring curve is only measured down to about
         2.5M total, so a small member's placing can be provisional until their
         gym log settles it. Holding shows the board but not a winner. */
      if (url.searchParams.has("hold") || url.searchParams.has("release")) {
        if (!isAdmin) return json({ error: "leaders only" }, 403, cors);
        const ev = evOf(doc, url.searchParams.get("ev"));
        if (!ev) return json({ error: "no such event" }, 400, cors);
        if (url.searchParams.has("release")) delete ev.held;
        else ev.held = (url.searchParams.get("hold") || "").slice(0, 120) || "the result is being checked";
        await save();
        return json({ ok: true, held: ev.held || null }, 200, cors);
      }

      if (url.searchParams.has("rebuild")) {
        if (!isAdmin) return json({ error: "leaders only" }, 403, cors);
        const keys = (await env.LEDGER.get("trainkeys", "json")) || {};
        const only = url.searchParams.get("ev");
        const done = [], added = [];
        for (const ev of doc.events) {
          if (only && ev.id !== only) continue;
          for (const [id, u] of Object.entries(ev.users || {})) {
            // &force=1 re-reads a log we have already used, for when the rebuild
            // itself has learned to extract something new from it
            if (u.fromLog && !url.searchParams.has("force")) {
              done.push({ ev: ev.id, name: u.name, skipped: "already from the log" }); continue;
            }
            if (!keys[id] || !keys[id].log) { done.push({ ev: ev.id, name: u.name, skipped: "no log key" }); continue }
            const sess = await gymSessions(keys[id].key, ev.from, ev.to);
            if (!sess) { done.push({ ev: ev.id, name: u.name, skipped: "log unreadable" }); continue }
            if (!sess.length) { done.push({ ev: ev.id, name: u.name, skipped: "no gym sessions in the window" }); continue }
            // the stats as they were at the END of the event, not as they are now:
            // a stat untrained during the event may well have been trained since
            const endStats = u.ls || u.fs;
            const rb = fromSessions(sess, endStats, ev.from);
            if (!rb) { done.push({ ev: ev.id, name: u.name, skipped: "no per-stat reading to build on" }); continue }
            const was = { first: u.first, gymE: u.gymE || null };
            u.first = rb.first; u.fs = rb.fs; u.fsEst = false;
            u.gymE = rb.energy; u.fromLog = true; u.s = rb.series.slice();
            u.jx = rb.jumps || [];
            const xl = await xanaxFromLog(keys[id].key, ev.from, ev.to);
            if (xl != null) u.xanLog = xl;
            done.push({ ev: ev.id, name: u.name, sessions: sess.length, energy: rb.energy,
                        baselineWas: was.first, baselineNow: rb.first, xanax: xl });
          }
        }

        /* ?add=1 as well: put somebody on a finished board who was never on it.
           Only possible for a log sharer, and only by rewinding — their stats
           today are not their stats at the close, so we read what they are now
           and subtract everything the log says they have gained since. */
        if (url.searchParams.has("add")) {
          for (const ev of doc.events) {
            if (only && ev.id !== only) continue;
            for (const [id, k] of Object.entries(keys)) {
              if (ev.users[id] || !k.log) continue;
              const inWin = await gymSessions(k.key, ev.from, ev.to);
              if (!inWin || !inWin.length) { added.push({ ev: ev.id, name: k.name, skipped: "did not train during it" }); continue }
              const now2 = Math.floor(Date.now() / 1000);
              const r = await readMember(k.key, false);
              if (!r || r._error) { added.push({ ev: ev.id, name: k.name, skipped: r ? r._error : "unreadable" }); continue }
              const since = await gymSessions(k.key, ev.to + 1, now2);
              if (!since) { added.push({ ev: ev.id, name: k.name, skipped: "could not rewind" }); continue }
              const end = { s: r.stats.s, d: r.stats.d, p: r.stats.p, x: r.stats.x };
              for (const g of since) end[STAT_KEY[g.stat]] -= g.inc;      // undo everything since the close
              const rb = fromSessions(inWin, end, ev.from);
              if (!rb) { added.push({ ev: ev.id, name: k.name, skipped: "could not rebuild" }); continue }
              const last = rb.series[rb.series.length - 1][1];
              ev.users[id] = { name: k.name, first: rb.first, firstAt: ev.from, fs: rb.fs, fsEst: false,
                               ls: end, last, gymE: rb.energy, fromLog: true, s: rb.series.slice(),
                               jx: rb.jumps || [],
                               maxE: k.maxE || 150 };
              const xl = await xanaxFromLog(k.key, ev.from, ev.to);
              if (xl != null) ev.users[id].xanLog = xl;
              if (ev.roster) ev.roster[id] = ev.from;
              added.push({ ev: ev.id, name: k.name, sessions: inWin.length, energy: rb.energy,
                           rewoundBy: since.length, baseline: rb.first, gained: last - rb.first, xanax: xl });
            }
          }
        }
        // anything already banked now says something different, so bank it again
        for (const ev of doc.events) {
          if (only && ev.id !== only) continue;
          if (ev.archived) await archiveEvent(env, doc, ev);
        }
        await save();
        return json({ ok: true, rebuilt: done, added }, 200, cors);
      }

      // Joining one event. The key is held from the first sign-up, so this is a
      // click: it only says "count me in this time".
      if (url.searchParams.has("join") || url.searchParams.has("unjoin")) {
        const id = +url.searchParams.get("id") || 0;
        const ev = evOf(doc, url.searchParams.get("ev"));
        if (!id || !ev) return json({ error: "need a member and an event" }, 400, cors);
        if (ev.to < now) return json({ error: "that event has finished" }, 400, cors);
        ev.roster = ev.roster || {};
        if (url.searchParams.has("unjoin")) { delete ev.roster[id]; delete ev.users[id] }
        else {
          ev.roster[id] = now;
          /* Take their starting point right now rather than waiting for the next
             tick. Joining and then seeing an empty board for two minutes looks
             broken, and for anyone sharing a gym log we can do far better than a
             blank row: their real baseline from the moment the event opened, the
             energy they have already spent and the line they have already drawn. */
          const keys = (await env.LEDGER.get("trainkeys", "json")) || {};
          const k = keys[id];
          if (k && !ev.users[id]) {
            const r = await readMember(k.key, false);
            if (r && !r._error) {
              const upto = Math.min(ev.to, now);
              const u = { name: k.name, first: r.total, firstAt: now, fs: r.stats || null,
                          ls: r.stats || null, last: r.total, s: [[now, r.total]],
                          maxE: k.maxE || 150 };
              if (k.log) {
                const sess = await gymSessions(k.key, ev.from, upto);
                if (sess && sess.length) {
                  const rb = fromSessions(sess, r.stats, ev.from);
                  if (rb) {
                    u.first = rb.first; u.fs = rb.fs; u.fsEst = false;
                    u.gymE = rb.energy; u.fromLog = true;
                    u.s = rb.series.slice(); u.jx = rb.jumps || [];
                    u.last = rb.series[rb.series.length - 1][1];
                  }
                } else if (sess) {
                  // sharing a log and not trained yet: the start of the event IS
                  // their baseline, so they are not counted as joining late
                  u.firstAt = ev.from; u.fromLog = true; u.gymE = 0;
                  u.s = [[ev.from, r.total]];
                }
                const xl = await xanaxFromLog(k.key, ev.from, upto);
                if (xl != null) u.xanLog = xl;
              }
              ev.users[id] = u;
            }
          }
        }
        doc.nextPoll = 0;                       // and keep reading from now on
        await save();
        return json({ ok: true, joined: !!ev.roster[id],
                      showing: ev.users[id] ? { from: ev.users[id].firstAt,
                                                fromLog: !!ev.users[id].fromLog,
                                                gymE: ev.users[id].gymE != null ? ev.users[id].gymE : null } : null }, 200, cors);
      }

      // Opting in: a member hands over their own key so the worker can take the
      // readings for them. Keys live in their own KV entry and are never served
      // by any endpoint — not to members, not to leaders.
      if (url.searchParams.has("enrol") || url.searchParams.has("leave")) {
        const id = +url.searchParams.get("id") || 0;
        if (!id) return json({ error: "missing id" }, 400, cors);
        const keys = (await env.LEDGER.get("trainkeys", "json")) || {};
        if (url.searchParams.has("leave")) { delete keys[id]; }
        else {
          const k = url.searchParams.get("key") || "";
          if (!k) return json({ error: "missing key" }, 400, cors);
          keys[id] = { key: k, name: (url.searchParams.get("name") || "").slice(0, 30), at: Math.floor(Date.now() / 1000) };
          keys[id].maxE = +url.searchParams.get("maxe") || await maxEnergy(k);
          // A custom key can grant `log` without being a Full key. info.log is
          // null either way — the marker is whether "log" is in the selections.
          keys[id].log = await hasLog(k);
        }
        await env.LEDGER.put("trainkeys", JSON.stringify(keys));
        return json({ ok: true, enrolled: !!keys[id] }, 200, cors);
      }
      if (url.searchParams.has("unbank")) {       // leaders: drop one archived event
        if (!isAdmin) return json({ error: "leaders only" }, 403, cors);
        const from = +url.searchParams.get("unbank") || 0;
        const h = (await env.LEDGER.get(HIST_KEY, "json")) || { events: [] };
        const before = (h.events || []).length;
        h.events = (h.events || []).filter(e => e.from !== from);
        await env.LEDGER.put(HIST_KEY, JSON.stringify(h));
        return json({ ok: true, removed: before - h.events.length }, 200, cors);
      }
      if (url.searchParams.has("drop")) {          // leaders: remove one entry without wiping the board
        if (!isAdmin) return json({ error: "leaders only" }, 403, cors);
        const d = +url.searchParams.get("drop") || 0;
        const ev = evOf(doc, url.searchParams.get("ev"));
        const targets = ev ? [ev] : doc.events;
        let had = false;
        for (const e of targets) if (e.users[d]) { delete e.users[d]; had = true }
        await save();
        return json({ ok: true, dropped: had }, 200, cors);
      }
      if (url.searchParams.has("enrolled")) {          // leaders: who opted in, names only
        if (!isAdmin) return json({ error: "leaders only" }, 403, cors);
        const keys = (await env.LEDGER.get("trainkeys", "json")) || {};
        const evR = evOf(doc, url.searchParams.get("ev")) || doc.events[doc.events.length - 1];
        return json({ enrolled: Object.entries(keys).map(([id, v]) => ({ id: +id, name: v.name, at: v.at,
                      log: !!v.log,
                      inEvent: evR && evR.roster ? (evR.roster[id] != null) : null })) }, 200, cors);
      }

      const id = +url.searchParams.get("id") || 0;
      const total = +url.searchParams.get("total") || 0;
      const openEvents = doc.events.filter(e => now >= e.from && now <= e.to);
      if (id && total && openEvents.length) {
        const name = (url.searchParams.get("name") || "").slice(0, 30);
        const num = n => +url.searchParams.get(n) || 0;
        const read = { total };
        if (num("str") && num("def")) read.stats = { s: num("str"), d: num("def"), p: num("spd"), x: num("dex") };
        if (url.searchParams.has("ref")) read.cons = { ref: num("ref"), drk: num("drk") };
        for (const ev of openEvents) {
          let u = ev.users[id];
          // first reading inside the window is the baseline, and it stays the
          // baseline — a later drop is a real loss, not a new start
          if (!u) u = ev.users[id] = { name, first: total, firstAt: now, s: [], fs: read.stats || null };
          else u.name = name || u.name;
          applyReading(u, now, read, num("maxe"));
        }
        await save();
      }

      const boardFor = ev => Object.entries(ev.users || {}).map(([uid, u]) => {
        const g = (u.last || 0) - (u.first || 0);
        const { d: den, tilt } = denomOf(u);
        /* The line has to end where the score ends. The score is capped and the
           line was not, so a capped member's line ran clean off the top of the
           chart — past 100% of a board that only adds up to 100. Scale the whole
           line by however much the cap took off, which keeps its shape and lands
           the last point exactly on the score. */
        const capK = (() => {
          const full = scoreOf(u, g), cut = scoreOf(u, g, energyOf(doc, ev, uid, u, now));
          return full > 0 ? cut / full : 1;
        })();
        // the chart follows the ranking, so it plots the adjusted score
        const toY = v => +(100 * (v - u.first) / den * tilt * capK).toFixed(3);
        const ser = den > 0 ? (u.s || []).map(([ts, v]) => [ts, toY(v)]) : [];
        // the bolts: a single training that beat par by JUMP_MARK or more, put
        // through the same conversion so each one sits exactly on the line
        const marks = den > 0 ? (u.jx || []).map(([ts, v, x]) => [ts, toY(v), x]) : [];
        // boards recorded by an older build lost their baseline timestamp from
        // the series, but firstAt still has it — put the anchor back
        if (ser.length && u.firstAt && ser[0][0] > u.firstAt) ser.unshift([u.firstAt, 0]);
        const spent = energyOf(doc, ev, uid, u, now);
        return {
          id: +uid, name: u.name,
          gain: u.first > 0 ? +(100 * g / u.first).toFixed(3) : 0,       // raw %
          adj: scoreOf(u, g, spent), exact: !!u.fs, split: !!u.ls, jump: jumpOf(doc, ev, uid, u, now),
          // whether the cap actually bit, so the page can say so rather than
          // leaving someone to wonder why a big number scored less than it looks
          capped: (u.first > 0 && g > 0 && spent > 0 && g > CAPX * parOf(u.first) * spent) || false,
          xan: xanTaken(doc, ev, uid, u, now), xanFromLog: u.xanLog != null,
          refills: Math.max(0, (u.ref || 0) - (u.firstR || 0)),
          cans: Math.max(0, (u.drk || 0) - (u.firstD || 0)),
          gymE: u.gymE != null ? u.gymE : null, fromLog: !!u.fromLog,
          // the audit column: gain per energy against par for their size. Only
          // meaningful where the energy is measured rather than estimated.
          vsPar: (u.gymE > 0 && u.first > 0 && g > 0)
                 ? +((g / u.gymE) / parOf(u.first)).toFixed(2) : null,
          marks,
          since: u.firstAt, updated: u.lastAt,
          lateBy: u.fromLog ? 0 : Math.max(0, u.firstAt - ev.from),
          series: ser
        };
      }).sort((a, b) => b.adj - a.adj);

      let enrolledMe = false;
      if (id) {
        const keys = (await env.LEDGER.get("trainkeys", "json")) || {};
        enrolledMe = !!keys[id];
      }
      // asked for only on load and on a manual refresh: the poll does not need
      // it, and this saves a KV read on every tick of every open page
      let history;
      if (url.searchParams.has("hist")) {
        const h = (await env.LEDGER.get(HIST_KEY, "json")) || { events: [] };
        history = h.events || [];
      }
      const events = doc.events
        .slice().sort((a, b) => a.from - b.from)
        .map(ev => ({ id: ev.id, name: ev.name, from: ev.from, to: ev.to, prizes: ev.prizes || null,
                      signedUp: ev.roster ? Object.keys(ev.roster).length : null,
                      youIn: ev.roster ? (id ? ev.roster[id] != null : false) : true,
                      open: now >= ev.from && now <= ev.to, locked: !!ev.locked,
                      held: ev.held || null,
                      board: boardFor(ev), keyTest: isAdmin ? (ev.keyTest || null) : null }));
      const first = events.find(e => e.open) || events[events.length - 1] || null;
      return json({ events, now, you: id || null, enrolled: enrolledMe, history,
                    scoring: { k1: K1, k2: K2, a1: A1, a2: A2, a3: A3, capx: CAPX,
                               tilt: TILT, ref: REF, floor: FLOOR,
                               parAt: PAR_AT, parT: PAR_T },
                    // what a page written before multiple events understands
                    event: first ? { from: first.from, to: first.to, name: first.name } : {},
                    open: !!(first && first.open), board: first ? first.board : [],
                    nextPoll: doc.nextPoll || null, pollEvery: 180 }, 200, cors);
    }

    if (!isAdmin) return json({ error: "bad or missing token" }, 403, cors);

    if (url.pathname.endsWith("/snaps")) {
      const facId = url.searchParams.get("fac");
      if (facId) {                                   // a friendly faction's own recording
        const doc = await env.LEDGER.get("fac:" + facId, "json");
        if (!doc) return json({ ours: [], med: [], last: null, note: "this worker is not recording that faction" }, 200, cors);
        return json({ ours: doc.ours, med: [], since: doc.since, last: doc.last }, 200, cors);
      }
      const warId = url.searchParams.get("war");
      if (!warId) return json({ error: "missing ?war= or ?fac=" }, 400, cors);
      const doc = await env.LEDGER.get("war:" + warId, "json");
      if (!doc) return json({ ours: [], med: [], last: null, note: "no recordings for this war yet" }, 200, cors);
      return json({ ours: doc.ours, med: doc.med, since: doc.since, last: doc.last }, 200, cors);
    }
    // Shared terms time: one value per war, so everyone's page agrees instead of
    // each person keeping their own in browser storage. ?set=<unix> writes it,
    // ?set=0 clears it, no ?set reads it.
    if (url.pathname.endsWith("/terms")) {
      const warId = url.searchParams.get("war");
      if (!warId) return json({ error: "missing ?war=" }, 400, cors);
      const key = "terms:" + warId;
      if (url.searchParams.has("set")) {
        const t = +url.searchParams.get("set") || 0;
        if (!t) { await env.LEDGER.delete(key); return json({ terms: null }, 200, cors); }
        await env.LEDGER.put(key, JSON.stringify({ terms: t, at: Math.floor(Date.now() / 1000) }));
        return json({ terms: t }, 200, cors);
      }
      const doc = await env.LEDGER.get(key, "json");
      return json(doc || { terms: null }, 200, cors);
    }
    if (url.pathname.endsWith("/status")) {
      const meta = (await env.LEDGER.get("meta", "json")) || { note: "worker has not ticked yet — check the cron trigger" };
      const now = Math.floor(Date.now() / 1000);
      const tw = testWindow(env, now);
      if (tw) {
        const doc = await env.LEDGER.get("war:test", "json");
        meta.test = { recording: !meta.active, opp: tw.oppId, endsIn: tw.until - now,
                      samples: doc ? doc.ours.length : 0, medOuts: doc ? doc.med.length : 0,
                      last: doc ? doc.last : null, error: meta.testError || null };
      } else if (+env.TEST_UNTIL) meta.test = { recording: false, note: "test window has expired" };
      return json(meta, 200, cors);
    }
    return json({ ok: true, endpoints: ["/snaps?war=ID", "/snaps?fac=ID", "/terms?war=ID", "/train", "/status"] }, 200, cors);
  }
};

function json(o, status, headers) { return new Response(JSON.stringify(o), { status, headers }); }

async function torn(env, path) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch("https://api.torn.com/v2" + path + sep + "key=" + env.TORN_API_KEY + "&comment=WarLedgerWorker");
  const j = await r.json();
  if (j && j.error) throw new Error(j.error.error + " (code " + j.error.code + ")");
  return j;
}

// Test mode: with no war on, record exactly what a war would record, against a
// nominated faction, under war id "test". Set TEST_UNTIL (unix seconds) and
// TEST_OPP (faction id) as plain vars in wrangler.toml; it stops on its own at
// TEST_UNTIL. Records on every other tick (4 min) to stay well inside the free
// KV tier's 1,000 writes/day, and yields immediately if a real war starts.
function testWindow(env, t) {
  const until = +env.TEST_UNTIL || 0;
  if (!until || t >= until) return null;
  return { warId: "test", oppId: +env.TEST_OPP || 0, start: 0, end: 0, test: true, until };
}

// Friendly factions (FRIEND_FACS, comma-separated ids) get their member statuses
// recorded the same way ours are, under fac:<id>, so their copy of the page can
// draw a real turtle board without running a worker of their own. Sampled less
// often than our own war, and less often again while we are at war, to stay
// inside the free tier's 1,000 KV writes/day.
const FRIEND_KEEP = 14 * 86400;
async function tickFriends(env, t, atWar) {
  const ids = String(env.FRIEND_FACS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!ids.length) return;
  const every = atWar ? 6 : 4;                       // minutes between samples
  if (Math.floor(t / 120) % (every / 2)) return;
  for (const id of ids) {
    try {
      const r = await torn(env, "/faction/" + id + "/members");
      const key = "fac:" + id;
      const doc = (await env.LEDGER.get(key, "json")) || { ours: [], state: {}, since: t };
      const ch = {};
      for (const m of (r.members || [])) {
        const st = m.status || {}; const state = st.state || "Okay"; const until = st.until || 0;
        let cause = "";
        if (state === "Hospital") {
          const d = String(st.details || st.description || "").toLowerCase();
          cause = (d.includes("hospitalized by") || d.includes("hospitalised by") ||
                   d.includes("attacked by") || d.includes("mugged by")) ? "enemy" : "self";
        }
        const prev = doc.state[m.id];
        if (!prev || prev[0] !== state || prev[2] !== cause) {
          doc.state[m.id] = [state, until, cause, m.name];
          ch[m.id] = [state, until, cause];
        } else prev[1] = until;
      }
      if (!Object.keys(ch).length) continue;         // nothing changed, nothing to write
      doc.ours.push({ t, ch });
      doc.ours = doc.ours.filter(s => s.t > t - FRIEND_KEEP);
      doc.last = t;
      await env.LEDGER.put(key, JSON.stringify(doc));
    } catch (e) { /* one faction failing must not stop the rest */ }
  }
}

// Members who opted in get their readings taken for them: once the event opens
// (the baseline nobody remembers to set), hourly after that, and once more just
// before it closes. One call per member per hour, against their own key. Each call uses that member's own key — the only key
// that can see their battle stats.
// Keep a thinned history per member so the clubhouse can draw a line each.
// Totals are stored but never served — the series goes out as percentages.
// Finished events, newest first. Only where everyone landed — no series, so a
// couple of dozen events stay small enough to send with every board read.
// 40 was too short and cut silently: "... - prize donated by friendly_derek"
// landed exactly on the limit and came back as "... - prize ".
const NAME_MAX = 80;
const HIST_KEY = "trainhist", HIST_MAX = 24, HIST_ROWS = 60;

/* Several events can run at once — a training weekend and a side game, say.
   They share one KV document (writes are the scarce thing, not space), one
   reading pass per member, and one armoury feed; each event only differs by its
   window and the baselines taken inside it. */
function migrate(doc){
  if (!doc) return doc;
  if (doc.events) return doc;
  doc.events = [];
  if (doc.event && doc.event.from) doc.events.push({
    id: String(doc.event.from), name: doc.event.name || "", from: doc.event.from, to: doc.event.to,
    users: doc.users || {}, locked: !!doc.locked, archived: !!doc.archived, keyTest: doc.keyTest || null });
  delete doc.event; delete doc.users; delete doc.locked; delete doc.archived; delete doc.keyTest; delete doc.arm;
  doc.readers = {}; doc.armLog = []; doc.armIds = []; doc.armCur = 0;   // the armoury backfills itself
  return doc;
}
/* Prizes are optional and set by leaders: p1/p2/p3, each "<itemId>:<name>".
   Only the places actually filled in are stored, so the members' page can show
   one, two or three without being told which. */
function readPrizes(url){
  const out = {};
  for (const n of [1, 2, 3]) {
    const raw = (url.searchParams.get("p" + n) || "").trim();
    if (!raw) continue;
    const at = raw.indexOf(":");
    const id = at > 0 ? +raw.slice(0, at) : 0;
    const name = (at > 0 ? raw.slice(at + 1) : raw).slice(0, 50).trim();
    if (!name) continue;
    out[n] = id > 0 ? { id, name } : { name };
  }
  return Object.keys(out).length ? out : null;
}

function evOf(doc, id){ return (doc.events || []).find(e => String(e.id) === String(id)) }

// Faction xanax is kept as one timestamped log, so any event — including one
// created later — can count its own window out of it without re-reading Torn.
function xanFor(doc, ev, uid, upto){
  return xanBetween(doc, uid, ev.from, Math.min(ev.to, upto));
}
function xanBetween(doc, uid, from, to){
  let n = 0;
  for (const e of (doc.armLog || [])) if (String(e.u) === String(uid) && e.t >= from && e.t <= to) n++;
  return n;
}

/* Xanax taken, counted from the log where we have it and from the faction
   armoury feed where we do not.

   The log is much the better source: exact, windowed to the event, and each
   entry even carries the faction id when that xanax came out of the armoury —
   so it needs no baseline and no subtracting one source from another. Torn's
   drugs.xanax counter can do none of that; it is a lifetime total that never
   says where anything came from, which is why the old "own" column had to go.

   The armoury feed still covers everyone without a log key, but it only sees
   what the faction handed out. */
const XAN_LOG_TYPES = "2290,2291";          // used a xanax / overdosed on one

async function xanaxFromLog(key, since, upto){
  let n = 0, cursor = upto, pages = 0;
  const seen = new Set();
  while (pages++ < 4) {
    let j;
    try {
      const r = await fetch("https://api.torn.com/user/?selections=log&log=" + XAN_LOG_TYPES
        + "&from=" + since + "&to=" + cursor + "&key=" + encodeURIComponent(key) + "&comment=CKClubhouse");
      j = await r.json();
    } catch (e) { return null }
    if (!j || j.error) return null;
    const rows = Object.entries(j.log || {});
    if (!rows.length) break;
    let oldest = Infinity;
    for (const [lid, e] of rows) {
      oldest = Math.min(oldest, e.timestamp);
      if (seen.has(lid)) continue;
      seen.add(lid);
      if (e.log !== 2290 && e.log !== 2291) continue;
      if (e.timestamp < since || e.timestamp > upto) continue;
      n++;
    }
    if (rows.length < 100 || oldest <= since) break;
    cursor = oldest - 1;
  }
  return n;
}

function xanTaken(doc, ev, uid, u, now){
  if (u.xanLog != null) return u.xanLog;
  return xanFor(doc, ev, uid, now);
}

function finalBoard(doc, ev){
  const now = Math.floor(Date.now() / 1000);
  return Object.entries(ev.users || {}).map(([uid, u]) => {
    const g = (u.last || 0) - (u.first || 0);
    return { id: +uid, name: u.name || "",
      gain: u.first > 0 ? +(100 * g / u.first).toFixed(3) : 0,       // raw, kept for the detail view
      adj: scoreOf(u, g, energyOf(doc, ev, uid, u, now)), exact: !!u.fs,
      xan: xanTaken(doc, ev, uid, u, now),
      refills: Math.max(0, (u.ref || 0) - (u.firstR || 0)),
      cans: Math.max(0, (u.drk || 0) - (u.firstD || 0)) };
  }).sort((a, b) => b.adj - a.adj).slice(0, HIST_ROWS);
}

async function archiveEvent(env, doc, ev){
  if (!ev || !ev.from) return false;
  const board = finalBoard(doc, ev);
  if (!board.length) return false;
  const h = (await env.LEDGER.get(HIST_KEY, "json")) || { events: [] };
  h.events = (h.events || []).filter(e => e.from !== ev.from);
  h.events.unshift({ from: ev.from, to: ev.to, name: ev.name || "", board });
  h.events = h.events.slice(0, HIST_MAX);
  await env.LEDGER.put(HIST_KEY, JSON.stringify(h));
  return true;
}

/* ---------------- scoring ----------------
   Ranking on plain % gain is unfair, but not evenly so, and the shape matters.
   Measured from 11,329 real gym trainings taken from the logs of the three
   members who share them — Mr_jeff14574 (3,191 sessions, stat 10 upwards),
   spill_298 (1,743, stat 24 upwards) and Top (6,395, 428M to 2bn) — pooled and
   binned by total stats, gain per energy rises like this:

        total stats                      slope of gain/energy
        360k ->  45M                     0.80 .. 1.09   (call it 0.95)
         45M -> 4.1bn                    0.44

   So through the ordinary range gain per energy rises almost in step with the
   stats themselves, which means raw % gain is already close to fair there. Past
   about 45M total it falls off a cliff, and that is where big players get hurt.
   One exponent cannot describe both, so there are two, meeting at the knee.

   Measured from 15,467 real gym trainings across all six members who share a
   log, pooled and binned by total stats. What makes this one trustworthy where
   the earlier fits were not: every band below a million now has four or five
   DIFFERENT players in it — Tpizz, Miramafia, theark, Mr_jeff14574 and
   spill_298 all have history down at stat 10 — so size is no longer standing in
   for "which person is this". The earlier two- and three-player fits could not
   separate the two, and got the bottom badly wrong as a result.

   Measured slope of gain-per-energy, segment by segment:

       300k -> 80M          0.80 .. 1.16, call it 0.95
       80M  -> 4.2bn        0.34
       under 300k           0.50, and this is the correction

   The bottom segment is the news. Extrapolating the middle slope down there,
   which is what the previous version did, under-stated par for a small member by
   about a quarter and inflated their score to match. It had Tpizz at 2.14x par
   when he was actually at 0.91x, and Miramafia at 4.49x when he was at 3.40x.

   Fitted this way the curve sits within 5% of the measured median across every
   band from 2,600 total upwards; the old one was 15% out. Below about a thousand
   total it is still poor, and nobody is down there.

   TILT is the deliberate thumb on the scale, and the only constant here that is
   a preference rather than a measurement.

   Deliberately NOT corrected for: which of the four stats someone trains. Torn
   prices a gym gain off the individual stat, not the total, so training your
   strongest stat buys more per energy than training your weakest. Measured on
   the first weekend, by energy-weighted stat trained against a quarter of their
   total: spill_298 trained a stat 1.41x his average, Mr_jeff14574 0.87x and Top
   0.85x. Price each man's gain against par for the stat he actually trained and
   the order changes — Mr_jeff14574 1.35x, spill_298 1.18x, Top 0.93x — where the
   board, scoring on the total, has them 1.28x, 1.70x and 0.87x.

   That is a decision, not an oversight: picking your best stat is a tactic open
   to everyone, like picking a good gym, and a competition should reward thinking
   about it. The members' page says so outright, so it is a known tactic rather
   than an edge for whoever happens to have read about it.

   The consequence for the audit column below: vsPar carries stat choice in it,
   so somebody grinding their strongest stat will sit above 1.0 every time and
   that is CORRECT, not a broken curve. Only a pattern that tracks SIZE means the
   curve is wrong.

   Which knob to turn, if it ever looks off:
   - TILT is the only one that is a PREFERENCE. Raise it to handicap big players
     harder, drop it to ease off, set it to 0 for dead level. Across this faction's
     range, 141k to 5.5bn, each 0.01 of TILT is about an 11% swing end to end.
   - K1, K2, A1, A2 and A3 are MEASUREMENTS, not preferences. Do not move them to
     change a placing; move them only when a new gym log says the curve is wrong.
     The signal for that is the vsPar column: it should scatter around 1.0 with no
     relation to size. If big members sit consistently below 1.0 and small ones
     above, the curve is wrong and these are what to change.

   TILT is the deliberate thumb on the scale. With it, five members from 141k to
   5.5bn all training at exactly their own par score within 1.23x of each other,
   with the biggest at the bottom of that band. Without it they are level.

   What this replaced, and a correction worth recording: first a per-stat cap at
   50M with a 3% tail, then briefly a single exponent of 0.535. The single
   exponent was fitted before Mr_jeff14574 shared his log, from just two players,
   and it put a 141k member last on a weekend where he had plainly out-trained
   everyone for his size. It was also justified partly on the grounds that both
   players showed an identical 0.500 happy used per energy — which turns out to
   be a constant of the game, true of all three members at every size, and so no
   evidence of matched happy at all. The percentile fits below are what actually
   controls for happy.

   The honest limits:
   - Three players cannot fully separate size from player, because each size band
     is dominated by one person. The exponent is stable from p10 to p90 of gain
     per energy (0.655 to 0.616 pooled), which is what makes it believable; the
     bin-to-bin wiggle is player, not size.
   - Below about 15k total the slope goes flat and noisy. Nobody is down there
     yet, and FLOOR damps it. Treat a score under ~50k total as provisional.
   - A member's own weekend cannot be used to check the curve, because effort and
     size are mixed in it: spill_298 trained at 1.70x his par that weekend,
     Mr_jeff14574 at 1.30x and Top at 1.05x. */
const K1    = 300000;       // total stats: below here the curve flattens off
const K2    = 80000000;     // and above here it flattens off again
const A1    = 0.50;         // measured slope below K1
const A2    = 0.95;         // measured slope between K1 and K2
const A3    = 0.34;         // measured slope above K2
const REF   = 10000000;     // scale anchor only; moving it moves every score alike
const TILT  = 0.02;         // the deliberate tilt against big players
const FLOOR = 20000;        // damps the very bottom, below the measured range
const CAPX  = 2.5;          // a weekend is scored as at most this many times par
const PAR_AT = 126.62;      // measured gain per energy ...
const PAR_T  = 12114816;    // ... at this total, the mid-range anchor

// Three straight lines in log-log, joined at the knees. Anchored so a member
// whose four stats total REF gets a denominator of exactly REF.
function curve(T){
  const t = (T || 0) + FLOOR;
  if (t <= K1) return A1 * Math.log(t / K1);
  if (t <= K2) return A2 * Math.log(t / K1);
  return A2 * Math.log(K2 / K1) + A3 * Math.log(t / K2);
}
// The denominator with no tilt: gain divided by this is size-blind.
function denomNeutral(T){ return REF * Math.exp(curve(T) - curve(REF)) }
// Stat points per energy that ordinary training buys at this size.
function parOf(T){ return PAR_AT / denomNeutral(PAR_T) * denomNeutral(T) }

function denomOf(u){
  const t = u.fs ? (u.fs.s || 0) + (u.fs.d || 0) + (u.fs.p || 0) + (u.fs.x || 0)
                 : (u.first || 0);
  return { d: denomNeutral(t), tilt: Math.pow(REF / (t + FLOOR), TILT) };
}

/* Happy jumps are allowed, so the score ignores them — but they are worth
   seeing. A jump is not a big gain, it is a big gain FOR THE ENERGY SPENT, so
   the test is to price the gain in energy at normal efficiency and compare it
   against the energy they could plausibly have had.

   An earlier version flagged the largest gain between two readings instead.
   That measures how much someone trained in one sitting, not how well: three
   xanax back to back looks identical to a jump. This does not depend on
   catching the moment at all, which also means it still works across a gap in
   the sampling.

   The energy estimate is deliberately generous. Over-stating what someone had
   available can only hide a jump; it can never invent one. */
const JUMP_PAR = parOf;        // the same measured curve the score uses
const JUMP_AT = 2;             // below this it is ordinary training
const JUMP_MARK = 2;           // a single training at this multiple gets a bolt on the chart

/* What they had to spend. Measured where the gym log gives it, estimated
   otherwise — and the estimate is pitched high on purpose: over-stating someone's
   energy can only hide a jump, it can never invent one. The cap and the jump
   flag both read this, so they cannot disagree about the same weekend. */
function energyOf(doc, ev, uid, u, now){
  if (u.gymE > 0) return u.gymE;
  const secs = Math.max(0, Math.min(ev.to, now) - (u.firstAt || ev.from));
  const xan = xanTaken(doc, ev, uid, u, now);
  const ref = Math.max(0, (u.ref || 0) - (u.firstR || 0));
  const drk = Math.max(0, (u.drk || 0) - (u.firstD || 0));
  return secs / 180                  // natural regen, 5 every 15 min
       + xan * 250                   // xanax, faction and personal
       + ref * (u.maxE || 150)       // a refill is a full bar
       + drk * 50;                   // energy cans, pitched high
}

function jumpOf(doc, ev, uid, u, now){
  if (!(u.first > 0)) return null;
  const gain = (u.last || 0) - (u.first || 0);
  if (gain <= 0) return null;
  const perEnergy = JUMP_PAR(u.first || 0);   // stat points per energy at their size
  if (perEnergy <= 0) return null;
  const implied = gain / perEnergy;
  const available = energyOf(doc, ev, uid, u, now);
  if (available <= 0) return null;
  const x = implied / available;
  return x >= JUMP_AT ? +x.toFixed(1) : null;
}

/* A weekend counts for at most CAPX times what ordinary training buys at that
   size. Jumps stay allowed and stay visible — the board prints the real gain,
   the real percentage and the real multiplier — but one enormous jump could
   otherwise settle a whole event, and what is being rewarded is the work put in
   across the weekend. Capping needs the energy, so in practice it needs a gym
   log; without one the energy is estimated, and that estimate is pitched high
   on purpose, so the cap is slow to bite for anyone not sharing. */
function scoreOf(u, gain, energy){
  const { d, tilt } = denomOf(u);
  if (!(d > 0)) return 0;
  let g = gain;
  if (energy > 0) {
    const ceiling = CAPX * parOf(u.first || 0) * energy;
    if (ceiling > 0 && g > ceiling) g = ceiling;
  }
  return +(100 * g / d * tilt).toFixed(3);
}

/* Xanax comes from the faction armoury log rather than each member's own
   counters. One call covers the whole faction, it reaches back to the start of
   the event instead of to whenever we started counting, and it measures what
   the faction actually handed out — which is the thing being given away. */
const ARM_RE = /XID=(\d+)[^>]*>([^<]*)<\/a>\s*used one of the faction's (.+?) items?/i;

// One call covers the whole faction and reaches back, so a new event can count
// xanax from before it was created. Deduped on news id — two entries can share
// a second — and the newest timestamp is read before the cursor walks back.
async function tickArmoury(env, doc, t, earliest){
  doc.armLog = doc.armLog || []; doc.armIds = doc.armIds || [];
  const seen = new Set(doc.armIds);
  const since = doc.armCur || earliest;
  const pages = doc.armCur ? 3 : 12;
  let to = t, newest = doc.armCur || 0;
  for (let i = 0; i < pages; i++) {
    const j = await torn(env, "/faction/news?cat=armoryAction&limit=100&sort=DESC&from=" + since + "&to=" + to);
    const list = j.news || [];
    if (!list.length) break;
    if (list[0].timestamp > newest) newest = list[0].timestamp;
    for (const n of list) {
      if (n.timestamp < earliest) continue;
      const nid = n.id != null ? String(n.id) : (n.timestamp + ":" + (n.text || "").slice(0, 40));
      if (seen.has(nid)) continue;
      seen.add(nid);
      const m = ARM_RE.exec(n.text || "");
      if (!m || !/xanax/i.test(m[3])) continue;
      doc.armLog.push({ t: n.timestamp, u: m[1] });
    }
    const last = list[list.length - 1].timestamp;
    if (list.length < 100 || last <= since) break;
    to = last - 1;
  }
  doc.armCur = newest;
  doc.armLog.sort((a, b) => a.t - b.t);
  if (doc.armLog.length > 4000) doc.armLog = doc.armLog.slice(-4000);
  doc.armIds = [...seen].slice(-600);
}

/* A key granting `log` turns the gym log into a complete, exact record: every
   session carries its timestamp, energy_used, trains, happy_used and the stat
   before, after and increased. Three things fall out of that which battle-stat
   sampling can never give us:

   1. Energy actually spent training, rather than inferred from xanax counts.
   2. A TRUE baseline. `<stat>_before` on the first session after the event
      opened is that stat's value at the opening, so someone who joined late
      can still be scored from the start — their stats then are recoverable.
   3. An exact gain curve, session by session, instead of a 3-minute sample.

   Only for members sharing a log; everyone else keeps the sampled version. */
const LOG_STATS = { 5300: "strength", 5301: "defense", 5302: "speed", 5303: "dexterity" };
const STAT_KEY = { strength: "s", defense: "d", speed: "p", dexterity: "x" };

// Whether a key can read logs. Stored at sign-up, and filled in on the next
// poll for anyone who enrolled before this existed.
async function hasLog(key){
  try {
    const ki = await (await fetch("https://api.torn.com/v2/key/info?key=" + encodeURIComponent(key))).json();
    return (((ki.info || ki).selections || {}).user || []).includes("log");
  } catch (e) { return false }
}

async function gymSessions(key, since, upto){
  const out = [];
  let cursor = upto, pages = 0;
  const seen = new Set();
  while (pages++ < 8) {
    let j;
    try {
      const r = await fetch("https://api.torn.com/user/?selections=log&log=5300,5301,5302,5303,5310"
        + "&from=" + since + "&to=" + cursor + "&key=" + encodeURIComponent(key) + "&comment=CKClubhouse");
      j = await r.json();
    } catch (e) { return null }
    if (!j || j.error) return null;
    const rows = Object.entries(j.log || {});
    if (!rows.length) break;
    let oldest = Infinity;
    for (const [lid, e] of rows) {
      oldest = Math.min(oldest, e.timestamp);
      if (seen.has(lid)) continue;
      seen.add(lid);
      if (e.category !== "Gym" || e.timestamp < since || e.timestamp > upto) continue;
      const stat = LOG_STATS[e.log];
      const d = e.data || {};
      if (!stat || d[stat + "_before"] == null) continue;
      out.push({ t: e.timestamp, stat,
                 before: parseFloat(d[stat + "_before"]),
                 inc: +d[stat + "_increased"] || 0,
                 energy: +d.energy_used || 0 });
    }
    if (rows.length < 100 || oldest <= since) break;
    cursor = oldest - 1;
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Rebuild someone's event from their log: where they started, and every step
// since. `nowStats` is their latest per-stat reading, used for stats they have
// not trained in this window — those are unchanged, so now IS the start.
function fromSessions(sessions, nowStats, from){
  if (!nowStats) return null;
  const start = { s: nowStats.s, d: nowStats.d, p: nowStats.p, x: nowStats.x };
  const earliest = {};
  for (const g of sessions) if (!(g.stat in earliest)) earliest[g.stat] = g.before;
  for (const [stat, v] of Object.entries(earliest)) start[STAT_KEY[stat]] = v;
  const first = start.s + start.d + start.p + start.x;
  let run = first;
  const series = [[from, first]];
  /* A single training that returned well over what the gym normally gives at
     that size — the signature of a happy jump. Priced per session against par
     for the stats they had going IN, so it is the training being judged, not
     the weekend. These carry their own value rather than a series index, so
     they survive the thinning below. */
  const jumps = [];
  for (const g of sessions) {
    const par = parOf(run);
    const x = (g.energy > 0 && par > 0) ? (g.inc / g.energy) / par : 0;
    run += g.inc;
    series.push([g.t, +run.toFixed(2)]);
    if (x >= JUMP_MARK) jumps.push([g.t, +run.toFixed(2), +x.toFixed(1)]);
  }
  // keep it to a sane size for the chart
  let s2 = series;
  while (s2.length > 220) s2 = s2.filter((_, i) => i % 2 === 0 || i >= s2.length - 60);
  return { first, fs: start, series: s2, jumps,
           energy: sessions.reduce((a, g) => a + g.energy, 0) };
}

// One category per call — Torn rejects "cat=drugs,items,other". battle_stats is
// five fields, cat=all is 217, and we already tripped Torn's daily record limit
// once, so the stats are read often and the consumables rarely.
async function psCat(key, cat){
  try {
    const r = await fetch("https://api.torn.com/v2/user/personalstats?cat=" + cat
      + "&key=" + encodeURIComponent(key) + "&comment=CKClubhouse");
    const j = await r.json();
    if (j && j.error) return { _error: j.error.error || ("code " + j.error.code) };
    return j.personalstats || {};
  } catch (e) { return { _error: "unreachable" } }
}

// Torn records no gym energy anywhere, so "energy used" can only be the energy
// a member *bought*: xanax at 250 each and energy refills at a full bar. Both
// are lifetime counters, so the first reading inside the window is the zero and
// everything after it is a delta. Natural regen is not counted — it cannot be.
function applyReading(u, t, r, maxE){
  if (maxE) u.maxE = maxE;
  // NEVER set u.fs here: "no split on file yet" is not the same as "this is the
  // start". A record born before per-stat recording existed would otherwise
  // adopt today's stats as its baseline, inflating the denominator and dragging
  // the adjusted score BELOW the raw one. fs is written at birth, and nowhere else.
  if (r.stats) u.ls = r.stats;
  // the log is authoritative where we have it: the real baseline, the real
  // curve, the real energy — including for someone who joined after the start
  if (r.xanLog != null) u.xanLog = r.xanLog;
  if (r.rebuilt) {
    u.first = r.rebuilt.first;
    u.fs = r.rebuilt.fs;
    u.fsEst = false;
    u.gymE = r.rebuilt.energy;
    u.fromLog = true;
    u.s = r.rebuilt.series.slice();
    u.jx = r.rebuilt.jumps || [];
  }
  if (r.cons) {
    // each counter gets its own guard. Sharing one meant that adding a counter
    // later left its baseline unset, and its "delta" was the lifetime total.
    if (u.firstR == null) u.firstR = r.cons.ref;
    if (u.firstD == null) u.firstD = r.cons.drk;
    if (u.firstX == null) { u.firstX = r.cons.xan; u.firstXAt = t }
    u.ref = r.cons.ref; u.drk = r.cons.drk; u.xan = r.cons.xan;
    u.fullAt = t;
  }
  u.last = r.total; u.lastAt = t;
  if (u.fromLog) {                      // the log stops at the last session; carry it to now
    const last = u.s[u.s.length - 1];
    if (!last || last[1] !== r.total) u.s.push([t, r.total]); else last[0] = t;
    return true;
  }
  return pushSample(u, t, r.total);
}

// Read a member: battle stats always, the four consumable counters only when
// asked for. Returns null if their key is no good.
async function readMember(key, withCons){
  const b = await psCat(key, "battle_stats");
  if (b._error) return { _error: b._error };
  const bs = b.battle_stats || b;
  const stats = { s: bs.strength || 0, d: bs.defense || 0, p: bs.speed || 0, x: bs.dexterity || 0 };
  const total = bs.total ?? (stats.s + stats.d + stats.p + stats.x);
  if (!total) return { _error: "no battle stats" };
  const out = { total, stats };
  if (withCons) {
    // xanax used to be read here too; it comes from the faction armoury now, so
    // this is two calls per member instead of three
    const [it, ot, dg] = await Promise.all([psCat(key, "items"), psCat(key, "other"), psCat(key, "drugs")]);
    if (!it._error && !ot._error && !dg._error) out.cons = {
      ref: (ot.other && ot.other.refills && ot.other.refills.energy) || 0,
      drk: (it.items && it.items.used && it.items.used.energy_drinks) || 0,
      xan: (dg.drugs && dg.drugs.xanax) || 0 };
  }
  return out;
}

// A refill is a full energy bar, so their maximum is needed to price it — the
// one figure that is not in personalstats. Read once, when they opt in.
async function maxEnergy(key){
  try {
    const r = await fetch("https://api.torn.com/v2/user/bars?key=" + encodeURIComponent(key) + "&comment=CKClubhouse");
    const b = await r.json();
    const e = (b.bars && b.bars.energy) || b.energy;
    return (e && e.maximum) || 0;
  } catch (e) { return 0 }
}

function pushSample(u, t, total){
  u.s = u.s || [];
  const n = u.s.length;
  const last = u.s[n - 1];
  // A flat stretch needs two points, not one. Collapsing it to a single
  // restamped point dragged the baseline forward every poll, so a line only
  // appeared from the moment that person trained — not from the start of the
  // event. Only ever move the END of a run that already has a start.
  if (last && last[1] === total) {
    if (n >= 2 && u.s[n - 2][1] === total) { last[0] = t; return false }
    u.s.push([t, total]);
    return false;
  }
  u.s.push([t, total]);
  if (u.s.length > 160) u.s = u.s.filter((_, i) => i % 2 === 0 || i >= u.s.length - 60);
  return true;
}

async function tickTraining(env, t, atWar) {
  const doc = migrate(await env.LEDGER.get("train", "json"));
  if (!doc || !doc.events || !doc.events.length) return;
  const keys = (await env.LEDGER.get("trainkeys", "json")) || {};
  const ids = Object.keys(keys);
  doc.readers = doc.readers || {};
  let dirty = false, keysChanged = false;

  // five minutes before any event opens, check everyone's key still works
  for (const ev of doc.events) {
    if (t < ev.from && ev.from - t <= 300 && !ev.keyTest && ids.length) {
      const bad = [];
      for (const id of ids) {
        const r = await psCat(keys[id].key, "battle_stats");
        if (r._error) bad.push({ id: +id, name: keys[id].name, why: r._error });
      }
      ev.keyTest = { at: t, checked: ids.length, bad };
      dirty = true;
    }
  }

  const over = ev => t > ev.to;
  const active = doc.events.filter(ev => t >= ev.from && !ev.locked);   // a just-ended event still owes a final reading
  const schedule = () => {
    const every = atWar ? 900 : 180;
    let next = t + (active.length ? every : 3600);
    for (const ev of doc.events) {
      if (t < ev.from) next = Math.min(next, ev.from);
      else if (!ev.locked && ev.to > t) next = Math.min(next, Math.min(t + every, ev.to + 1));
    }
    doc.nextPoll = next;
  };

  if (!active.length || !ids.length) {
    schedule();
    if (dirty || !active.length) await env.LEDGER.put("train", JSON.stringify(doc));
    return;
  }

  const mustFinal = active.some(over);
  if (doc.nextPoll && t < doc.nextPoll && !mustFinal) {
    if (dirty) await env.LEDGER.put("train", JSON.stringify(doc));
    return;
  }

  // The free plan allows 50 subrequests per invocation. Battle stats cost one
  // per member and the consumables three, so the consumables rotate through
  // whoever is most overdue rather than everyone refreshing at once. One
  // reading pass serves every event a member is in.
  let budget = 40 - ids.length - 1;
  const wantCons = new Set();
  for (const id of ids) if (!doc.readers[id] && budget >= 3) { wantCons.add(id); budget -= 3 }
  const overdue = ids.filter(id => doc.readers[id]).sort((a, b) => (doc.readers[a].fullAt || 0) - (doc.readers[b].fullAt || 0));
  for (const id of overdue) {
    if (budget < 3) break;
    if (!mustFinal && t - (doc.readers[id].fullAt || 0) < 900) break;
    wantCons.add(id); budget -= 3;
  }

  const reads = {};
  for (const id of ids) {
    try {
      if (keys[id].maxE == null) { keys[id].maxE = await maxEnergy(keys[id].key); keysChanged = true }
      if (keys[id].log == null) { keys[id].log = await hasLog(keys[id].key); keysChanged = true }
      const r = await readMember(keys[id].key, wantCons.has(id));
      if (r._error) continue;                      // a dead key must not stop the rest
      reads[id] = r;
      if (keys[id].log && wantCons.has(id)) r.gymKey = keys[id].key;
      doc.readers[id] = doc.readers[id] || { fullAt: 0 };
      if (r.cons) doc.readers[id].fullAt = t;
    } catch (e) { /* skip and try again next time */ }
  }

  // gym energy is per event, because each event has its own window
  const inEvent = (ev, id) => !ev.roster || ev.roster[id] != null;   // no roster = an event from before opt-in
  for (const ev of active) {
    for (const [id, r] of Object.entries(reads)) {
      if (!inEvent(ev, id) || !r.gymKey) continue;
      const upto = Math.min(ev.to, t);
      const sess = await gymSessions(r.gymKey, ev.from, upto);
      if (sess) r.rebuilt = fromSessions(sess, r.stats, ev.from);
      const xl = await xanaxFromLog(r.gymKey, ev.from, upto);
      if (xl != null) r.xanLog = xl;
    }
    for (const [id, r] of Object.entries(reads)) {
      if (!inEvent(ev, id)) continue;
      let u = ev.users[id];
      if (!u) u = ev.users[id] = { name: keys[id].name, first: r.total, firstAt: t, s: [],
                                   fs: r.stats || null };          // the baseline split, captured once
      else if (keys[id].name) u.name = keys[id].name;
      applyReading(u, t, r, keys[id].maxE);
    }
  }

  try { await tickArmoury(env, doc, t, Math.min(...active.map(e => e.from))) }
  catch (e) { /* the stats matter more */ }

  for (const ev of active) {
    if (!over(ev)) continue;
    ev.locked = true;                               // the final reading is in
    if (!ev.archived && await archiveEvent(env, doc, ev)) ev.archived = true;
  }

  schedule();
  if (keysChanged) await env.LEDGER.put("trainkeys", JSON.stringify(keys));
  // a poll where nobody moved still has to remember when it ran, but that is
  // one write for every event at once rather than one each
  await env.LEDGER.put("train", JSON.stringify(doc));
}

async function tick(env) {
  const t = Math.floor(Date.now() / 1000);
  let meta = (await env.LEDGER.get("meta", "json")) || {};

  // Find the active (or imminent) ranked war; re-check every 10 min.
  // Time-based only: re-checking on every idle tick burned a KV write each time.
  if ((meta.activeCheckedAt || 0) < t - 600) {
    try {
      if (!meta.facId) {
        const b = await torn(env, "/faction/basic");
        meta.facId = (b.basic || b).id;
      }
      const rw = await torn(env, "/faction/rankedwars");
      const wars = rw.rankedwars || [];
      const startOf = w => w.start ?? (w.war && w.war.start);
      const endOf = w => (w.end ?? (w.war && w.war.end)) || 0;
      const pick = wars.find(w => startOf(w) <= t && (!endOf(w) || endOf(w) > t))
                || wars.find(w => startOf(w) > t && startOf(w) < t + 900); // starts within 15 min
      if (pick) {
        const facs = pick.factions || [];
        const opp = facs.find(f => (f.id ?? f.faction_id) != meta.facId) || {};
        meta.active = { warId: pick.id ?? pick.war_id, oppId: opp.id ?? opp.faction_id,
                        start: startOf(pick), end: endOf(pick) };
      } else meta.active = null;
      meta.activeCheckedAt = t; meta.lastError = null; meta.lastTick = t;
      await env.LEDGER.put("meta", JSON.stringify(meta));
    } catch (e) {
      meta.lastError = String(e.message || e); meta.activeCheckedAt = t; meta.lastTick = t;
      await env.LEDGER.put("meta", JSON.stringify(meta));
      return;
    }
  }

  await tickFriends(env, t, !!meta.active);
  await tickTraining(env, t, !!meta.active);

  let act = meta.active;
  if (act && act.start > t) return;
  if (act && act.end && t > act.end + 1800) { // war over (30 min grace)
    meta.active = null;
    await env.LEDGER.put("meta", JSON.stringify(meta));
    act = null;
  }
  if (!act) {                          // no real war — fall back to test mode if armed
    act = testWindow(env, t);
    if (!act) return;
    if (Math.floor(t / 120) % 2) return;  // every other tick: 4 min, half the writes
  }

  const key = "war:" + act.warId;
  const doc = (await env.LEDGER.get(key, "json")) || { ours: [], med: [], state: {}, estate: {}, since: t };
  try {
    const ours = await torn(env, "/faction/members");

    // our side: record status changes as diffs
    const ch = {};
    for (const m of (ours.members || [])) {
      const st = m.status || {}; const state = st.state || "Okay"; const until = st.until || 0;
      let cause = "";
      if (state === "Hospital") {
        const d = String(st.details || st.description || "").toLowerCase();
        cause = (d.includes("hospitalized by") || d.includes("hospitalised by") ||
                 d.includes("attacked by") || d.includes("mugged by")) ? "enemy" : "self";
      }
      const prev = doc.state[m.id];
      if (!prev || prev[0] !== state || prev[2] !== cause) {
        doc.state[m.id] = [state, until, cause, m.name];
        ch[m.id] = [state, until, cause];
      } else prev[1] = until;
    }
    if (Object.keys(ch).length) doc.ours.push({ t, ch });

    doc.last = t;
    await env.LEDGER.put(key, JSON.stringify(doc));
    if (act.test && meta.testError) { meta.testError = null; await env.LEDGER.put("meta", JSON.stringify(meta)); }
  } catch (e) {
    // test errors get their own field: the 10-minute war re-check clears lastError
    if (act.test) meta.testError = String(e.message || e); else meta.lastError = String(e.message || e);
    meta.lastTick = t;
    await env.LEDGER.put("meta", JSON.stringify(meta));
  }
}
