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
      let doc = (await env.LEDGER.get(key, "json")) || { users: {}, event: {} };
      const now = Math.floor(Date.now() / 1000);

      // Leaders set the bracket. Torn keeps no history of battle stats — a
      // timestamped request just returns today's figures — so a baseline only
      // exists if someone recorded one while the event was running. Changing
      // the window therefore starts a fresh board.
      if (url.searchParams.has("set") || url.searchParams.has("reset")) {
        if (!isAdmin) return json({ error: "leaders only" }, 403, cors);
        const from = +url.searchParams.get("from") || now;
        const to = +url.searchParams.get("to") || (from + 2 * 86400);
        // opening a different event banks the outgoing one first; reopening the
        // same window is a do-over and must not bank a half-finished board
        let banked = false;
        if (!doc.event || doc.event.from !== from) banked = await archiveEvent(env, doc);
        doc = { users: {}, event: { from, to, name: (url.searchParams.get("name") || "").slice(0, 40) } };
        await env.LEDGER.put(key, JSON.stringify(doc));
        return json({ ok: true, event: doc.event, banked }, 200, cors);
      }

      // Changing a running event without clearing it. Opening an event is the
      // destructive one; this is for fixing a name or moving the finish line.
      if (url.searchParams.has("edit")) {
        if (!isAdmin) return json({ error: "leaders only" }, 403, cors);
        const ev = doc.event;
        if (!ev || !ev.from) return json({ error: "there is no event to edit" }, 400, cors);
        if (url.searchParams.has("name")) ev.name = (url.searchParams.get("name") || "").slice(0, 40);
        if (url.searchParams.has("to")) {
          const to = +url.searchParams.get("to") || 0;
          if (to <= ev.from) return json({ error: "the end must be after the start" }, 400, cors);
          ev.to = to;
          if (to > now) { doc.locked = false; delete doc.archived }   // reopened: let it record again
        }
        if (url.searchParams.has("from")) {
          const from = +url.searchParams.get("from") || 0;
          // Moving the start of a running event would silently redefine what
          // everyone's baseline means, so it is only allowed before it opens.
          if (now >= ev.from) return json({ error: "it has already started — the start can't move now" }, 400, cors);
          if (from >= ev.to) return json({ error: "the start must be before the end" }, 400, cors);
          ev.from = from; delete doc.keyTest;
        }
        doc.nextPoll = 0;                      // take a fresh look at the schedule
        await env.LEDGER.put(key, JSON.stringify(doc));
        return json({ ok: true, event: ev }, 200, cors);
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
          // a custom key may grant log access without being a Full key; record
          // what this one allows so the gym/FHC columns know who to ask
          try {
            const ki = await (await fetch("https://api.torn.com/v2/key/info?key=" + encodeURIComponent(k))).json();
            keys[id].log = (ki.info && ki.info.log && ki.info.log.available) || [];
          } catch (e) { keys[id].log = [] }
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
        const had = !!doc.users[d];
        delete doc.users[d];
        await env.LEDGER.put(key, JSON.stringify(doc));
        return json({ ok: true, dropped: had }, 200, cors);
      }
      if (url.searchParams.has("enrolled")) {          // leaders: who opted in, names only
        if (!isAdmin) return json({ error: "leaders only" }, 403, cors);
        const keys = (await env.LEDGER.get("trainkeys", "json")) || {};
        return json({ enrolled: Object.entries(keys).map(([id, v]) => ({ id: +id, name: v.name, at: v.at,
                      log: (v.log || []).length ? v.log : null })) }, 200, cors);
      }

      const ev = doc.event || {};
      const open = ev.from && ev.to && now >= ev.from && now <= ev.to;
      const id = +url.searchParams.get("id") || 0;
      const total = +url.searchParams.get("total") || 0;
      if (id && total && open) {
        const name = (url.searchParams.get("name") || "").slice(0, 30);
        const num = n => +url.searchParams.get(n) || 0;
        const read = { total };
        if (num("str") && num("def")) read.stats = { s: num("str"), d: num("def"), p: num("spd"), x: num("dex") };
        if (url.searchParams.has("xan")) read.cons = { xan: num("xan"), ref: num("ref"), drk: num("drk"), bst: num("bst") };
        const maxE = +url.searchParams.get("maxe") || 0;
        let u = doc.users[id];
        // first reading inside the window is the baseline, and it stays the
        // baseline — a later drop is a real loss, not a new start
        if (!u) u = doc.users[id] = { name, first: total, firstAt: now, s: [], fs: read.stats || null };
        else u.name = name || u.name;
        applyReading(u, now, read, maxE);
        await env.LEDGER.put(key, JSON.stringify(doc));
      }

      // percentages only: absolute battle stats stay private
      const board = Object.entries(doc.users).map(([uid, u]) => {
        // counters are lifetime, so only the movement since their first reading
        // belongs to this event
        const ref = Math.max(0, (u.ref || 0) - (u.firstR || 0));
        const drk = Math.max(0, (u.drk || 0) - (u.firstD || 0));
        const xan = ((doc.arm && doc.arm.xan) || {})[uid] || 0;      // faction supply
        const g = (u.last || 0) - (u.first || 0);
        const den = denomOf(u), sc = Math.pow(den, PEXP) * Math.pow(REF, 1 - PEXP);
        // the chart follows the ranking, so it plots the adjusted score
        const ser = sc > 0 ? (u.s || []).map(([ts, v]) => [ts, +(100 * (v - u.first) / sc).toFixed(3)]) : [];
        // boards recorded by the older build lost their baseline timestamp from
        // the series, but firstAt still has it — put the anchor back
        if (ser.length && u.firstAt && ser[0][0] > u.firstAt) ser.unshift([u.firstAt, 0]);
        return {
        id: +uid, name: u.name,
        gain: u.first > 0 ? +(100 * g / u.first).toFixed(3) : 0,       // raw %
        adj: scoreOf(u, g), exact: !!u.fs && !u.fsEst, split: !!u.ls,
        xan, refills: ref, cans: drk,
        since: u.firstAt, updated: u.lastAt,
        lateBy: ev.from ? Math.max(0, u.firstAt - ev.from) : 0,
        series: ser
      }}).sort((a, b) => b.adj - a.adj);
      let enrolledMe = false;
      if (id) {
        const keys = (await env.LEDGER.get("trainkeys", "json")) || {};
        enrolledMe = !!keys[id];
      }
      // asked for only on load and on a manual refresh: the two-minute poll does
      // not need it, and this saves a KV read on every tick of every open page
      let history;
      if (url.searchParams.has("hist")) {
        const h = (await env.LEDGER.get(HIST_KEY, "json")) || { events: [] };
        history = h.events || [];
      }
      return json({ event: ev, open: !!open, now, board, you: id || null, enrolled: enrolledMe,
                    history, scoring: { cap: CAP, p: PEXP, ref: REF },
                    locked: !!doc.locked, keyTest: isAdmin ? (doc.keyTest || null) : null,
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
const HIST_KEY = "trainhist", HIST_MAX = 24, HIST_ROWS = 60;

function finalBoard(doc){
  return Object.entries(doc.users || {}).map(([uid, u]) => {
    const g = (u.last || 0) - (u.first || 0);
    return { id: +uid, name: u.name || "",
      gain: u.first > 0 ? +(100 * g / u.first).toFixed(3) : 0,       // raw, kept for the detail view
      adj: scoreOf(u, g), exact: !!u.fs,
      xan: ((doc.arm && doc.arm.xan) || {})[uid] || 0,
      refills: Math.max(0, (u.ref || 0) - (u.firstR || 0)),
      cans: Math.max(0, (u.drk || 0) - (u.firstD || 0)) };
  }).sort((a, b) => b.adj - a.adj).slice(0, HIST_ROWS);
}

// Banked before a board is cleared, and again by the cron once an event closes,
// so the all-time table does not depend on anyone remembering to do it. Keyed
// on the event's start, so archiving the same event twice updates it instead of
// adding a duplicate.
async function archiveEvent(env, doc){
  const ev = doc && doc.event;
  if (!ev || !ev.from) return false;
  const board = finalBoard(doc);
  if (!board.length) return false;
  const h = (await env.LEDGER.get(HIST_KEY, "json")) || { events: [] };
  h.events = (h.events || []).filter(e => e.from !== ev.from);
  h.events.unshift({ from: ev.from, to: ev.to, name: ev.name || "", board });
  h.events = h.events.slice(0, HIST_MAX);
  await env.LEDGER.put(HIST_KEY, JSON.stringify(h));
  return true;
}

/* ---------------- scoring ----------------
   Gym gains scale with the stat up to CAP and are heavily dampened above it, so
   ranking on plain % gain punishes big players for being big. The denominator
   is therefore the sum of the four stats AS THEY WERE AT THE BASELINE, each
   capped. That handles the dampening above CAP, but below it a smaller player
   still gains a larger PERCENTAGE for the same work, so P tilts the whole scale:
   the score is divided by denom^P instead of denom. P=1 is plain capped
   percentage (small players keep their full advantage), lower P hands more back
   to bigger players. REF anchors the scale, so a player capped on all four
   stats scores the same at every P and everyone else rotates around them. */
const CAP = 50000000;          // per stat
const PEXP = 0.85;             // 1 = plain capped percentage; lower favours bigger players
const REF = 4 * CAP;           // the scale anchor: a player capped on all four

function denomOf(u){
  if (u.fs) return (Math.min(u.fs.s || 0, CAP) + Math.min(u.fs.d || 0, CAP)
                  + Math.min(u.fs.p || 0, CAP) + Math.min(u.fs.x || 0, CAP));
  return Math.min(u.first || 0, REF);     // no per-stat baseline on file: the fallback
}
function scoreOf(u, gain){
  const d = denomOf(u);
  if (d <= 0) return 0;
  return +(100 * gain / (Math.pow(d, PEXP) * Math.pow(REF, 1 - PEXP))).toFixed(3);
}

/* Xanax comes from the faction armoury log rather than each member's own
   counters. One call covers the whole faction, it reaches back to the start of
   the event instead of to whenever we started counting, and it measures what
   the faction actually handed out — which is the thing being given away. */
const ARM_RE = /XID=(\d+)[^>]*>([^<]*)<\/a>\s*used one of the faction's (.+?) items?/i;

async function tickArmoury(env, doc, t){
  const ev = doc.event;
  const a = doc.arm || (doc.arm = { xan: {}, ids: [], cursor: 0 });
  const seen = new Set(a.ids || []);
  // first pass walks back to the start of the event; later ones only pick up
  // what has happened since
  const since = a.cursor || ev.from;
  const pages = a.cursor ? 3 : 12;
  let to = t, newest = a.cursor || 0;
  for (let i = 0; i < pages; i++) {
    const j = await torn(env, "/faction/news?cat=armoryAction&limit=100&sort=DESC&from=" + since + "&to=" + to);
    const list = j.news || [];
    if (!list.length) break;
    if (list[0].timestamp > newest) newest = list[0].timestamp;   // captured before `to` moves
    for (const n of list) {
      if (n.timestamp < ev.from) continue;
      const nid = n.id != null ? String(n.id) : (n.timestamp + ":" + (n.text || "").slice(0, 40));
      if (seen.has(nid)) continue;                 // ids, not timestamps: two can share a second
      const m = ARM_RE.exec(n.text || "");
      if (!m || !/xanax/i.test(m[3])) { seen.add(nid); continue }
      a.xan[m[1]] = (a.xan[m[1]] || 0) + 1;
      seen.add(nid);
    }
    const last = list[list.length - 1].timestamp;
    if (list.length < 100 || last <= since) break;
    to = last - 1;
  }
  a.cursor = newest;
  a.ids = [...seen].slice(-400);
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
  if (r.cons) {
    // each counter gets its own guard. Sharing one meant that adding a counter
    // later left its baseline unset, and its "delta" was the lifetime total.
    if (u.firstR == null) u.firstR = r.cons.ref;
    if (u.firstD == null) u.firstD = r.cons.drk;
    u.ref = r.cons.ref; u.drk = r.cons.drk;
    u.fullAt = t;
  }
  u.last = r.total; u.lastAt = t;
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
    const [it, ot] = await Promise.all([psCat(key, "items"), psCat(key, "other")]);
    if (!it._error && !ot._error) out.cons = {
      ref: (ot.other && ot.other.refills && ot.other.refills.energy) || 0,
      drk: (it.items && it.items.used && it.items.used.energy_drinks) || 0 };
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
  const doc = await env.LEDGER.get("train", "json");
  if (!doc || !doc.event || !doc.event.from) return;
  const ev = doc.event;
  const keys = (await env.LEDGER.get("trainkeys", "json")) || {};
  const ids = Object.keys(keys);

  // ---- before the start: nothing to record, but check the keys work ----
  if (t < ev.from) {
    if (ev.from - t <= 300 && !doc.keyTest && ids.length) {
      const bad = [];
      for (const id of ids) {
        const r = await psCat(keys[id].key, "battle_stats");
        if (r._error) bad.push({ id: +id, name: keys[id].name, why: r._error });
      }
      doc.keyTest = { at: t, checked: ids.length, bad };
      doc.nextPoll = ev.from;                 // the baseline is taken AT the start
      await env.LEDGER.put("train", JSON.stringify(doc));
    }
    return;
  }

  // ---- after the end: one final reading, then lock ----
  const over = t > ev.to;
  if (over && doc.locked) return;

  if (doc.nextPoll && t < doc.nextPoll && !over) return;

  // 3 minutes normally; back off to 15 while a war is recording, so the two
  // together stay inside the free tier's 1,000 KV writes a day
  const every = atWar ? 900 : 180;
  if (!ids.length) { doc.nextPoll = t + 3600; await env.LEDGER.put("train", JSON.stringify(doc)); return }

  // The free plan allows 50 subrequests per invocation. Battle stats cost one
  // per member and the consumables three, so the consumables rotate through
  // whoever is most overdue rather than everyone refreshing at once.
  let budget = 40 - ids.length - 1;             // one left for the armoury feed
  const wantCons = new Set();
  const overdue = ids.filter(id => doc.users[id])
    .sort((a, b) => (doc.users[a].fullAt || 0) - (doc.users[b].fullAt || 0));
  for (const id of ids) if (!doc.users[id] && budget >= 3) { wantCons.add(id); budget -= 3 }  // baselines first
  if (over) for (const id of overdue) if (budget >= 3) { wantCons.add(id); budget -= 3 }      // and the final reading
  else for (const id of overdue) {
    if (budget < 3) break;
    if (t - (doc.users[id].fullAt || 0) < 900) break;
    wantCons.add(id); budget -= 3;
  }

  let keysChanged = false;
  for (const id of ids) {
    try {
      // anyone who opted in before refills were priced needs their maximum once
      if (keys[id].maxE == null) { keys[id].maxE = await maxEnergy(keys[id].key); keysChanged = true }
      const read = await readMember(keys[id].key, wantCons.has(id));
      if (read._error) continue;                      // a dead key must not stop the rest
      let u = doc.users[id];
      if (!u) u = doc.users[id] = { name: keys[id].name, first: read.total, firstAt: t, s: [],
                                    fs: read.stats || null };          // the baseline split, captured once
      else if (keys[id].name) u.name = keys[id].name;
      applyReading(u, t, read, keys[id].maxE);
    } catch (e) { /* skip and try again next time */ }
  }

  try { await tickArmoury(env, doc, t) } catch (e) { /* the stats matter more */ }

  if (over) {                       // the final reading is in: bank it and stop
    doc.locked = true;
    if (!doc.archived && await archiveEvent(env, doc)) doc.archived = true;
  } else {
    const nearEnd = ev.to - 120;
    doc.nextPoll = t >= nearEnd ? ev.to + 1 : Math.min(t + every, nearEnd);
  }
  // a poll where nobody moved still has to remember when it ran, but that is
  // one write instead of one per member
  if (keysChanged) await env.LEDGER.put("trainkeys", JSON.stringify(keys));
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
