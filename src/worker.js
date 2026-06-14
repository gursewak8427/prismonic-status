// status.prismonic.com — Cloudflare Worker.
//
// Runs every 5 minutes, hits every public Prismonic endpoint, stores
// per-tick results in KV, renders a branded health page, and emails the
// V3 backend on UP↔DOWN transitions so it can fan out alerts.
//
// All edits land via Git — push to main, GitHub Actions runs
// `wrangler deploy`. No direct API uploads.

const SERVICES = [
  {
    id: "v3-api-prod",
    group: "Backend",
    name: "V3 API",
    desc: "api.v3.prismonic.com",
    url: "https://api.v3.prismonic.com/api/v1/settings",
    check: "json-success",
  },
  {
    id: "v3-api-staging",
    group: "Backend",
    name: "V3 API (Staging)",
    desc: "staging.api.v3.prismonic.com",
    url: "https://staging.api.v3.prismonic.com/api/v1/settings",
    check: "json-success",
  },
  {
    id: "v2-api-https",
    group: "Backend",
    name: "V2 API (HTTPS)",
    desc: "https://backend.prismonic.com  ·  VGP + Flutter",
    url: "https://backend.prismonic.com/",
    check: "status-200",
  },
  {
    id: "v2-api-http",
    group: "Backend",
    name: "V2 API (HTTP)",
    desc: "http://backend.prismonic.com  ·  legacy clients",
    url: "http://backend.prismonic.com/",
    check: "status-200",
  },
  {
    id: "banibot-catalogue",
    group: "Bani Bot",
    name: "Catalogue API",
    desc: "albums + tracks served to the device",
    url: "https://api.v3.prismonic.com/api/v1/banibot/albums",
    check: "json-success",
  },
  {
    id: "storefront-prod",
    group: "Web",
    name: "Storefront",
    desc: "prismonic.com",
    url: "https://prismonic.com/",
    check: "status-200",
  },
  {
    id: "storefront-staging",
    group: "Web",
    name: "Storefront (Staging)",
    desc: "staging.prismonic.com",
    url: "https://staging.prismonic.com/",
    check: "status-200",
  },
  {
    id: "admin-prod",
    group: "Web",
    name: "Admin Panel",
    desc: "admin.prismonic.com",
    url: "https://admin.prismonic.com/",
    check: "status-200",
  },
  {
    id: "admin-staging",
    group: "Web",
    name: "Admin Panel (Staging)",
    desc: "staging.admin.prismonic.com",
    url: "https://staging.admin.prismonic.com/",
    check: "status-200",
  },
  {
    id: "radio-live",
    group: "Radio",
    name: "Live Stream",
    desc: "radio.prismonic.com/live.mp3",
    url: "https://radio.prismonic.com/live.mp3",
    check: "audio-mpeg",
  },
  {
    id: "radio-multi",
    group: "Radio",
    name: "Multi-live Relay",
    desc: "radio.prismonic.com/live/1.mp3",
    url: "https://radio.prismonic.com/live/1.mp3",
    check: "audio-mpeg",
  },
];

const CHECK_TIMEOUT_MS = 6000;
const HISTORY_DAYS = 7;
const DAY_MS = 86_400_000;
/** Match the cron in wrangler.toml — drives the page subtitle + refresh. */
const TICK_MINUTES = 5;

async function runCheck(svc) {
  const started = Date.now();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const headers = svc.check === "audio-mpeg" ? { Range: "bytes=0-127" } : {};
    const res = await fetch(svc.url, {
      signal: controller.signal,
      redirect: "follow",
      headers,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const elapsed = Date.now() - started;
    let ok = res.ok;
    let reason = "";
    if (svc.check === "json-success") {
      const text = await res.text();
      try {
        const j = JSON.parse(text);
        ok = ok && j && j.success === true;
        if (!ok) reason = j && j.message ? j.message : `HTTP ${res.status}`;
      } catch (_) {
        ok = false;
        reason = "Invalid JSON";
      }
    } else if (svc.check === "audio-mpeg") {
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      ok = ok && (ct.includes("audio/mpeg") || ct.includes("audio/mp3"));
      if (!ok) reason = `Content-Type=${ct || "?"}`;
    } else {
      ok = res.status >= 200 && res.status < 400;
      if (!ok) reason = `HTTP ${res.status}`;
    }
    return { id: svc.id, ok, status: res.status, ms: elapsed, reason: ok ? "" : reason, at: Date.now() };
  } catch (e) {
    return {
      id: svc.id,
      ok: false,
      status: 0,
      ms: Date.now() - started,
      reason: e && e.name === "AbortError" ? "Timeout" : String(e && e.message || e),
      at: Date.now(),
    };
  } finally {
    clearTimeout(t);
  }
}

async function runAll() {
  return Promise.all(SERVICES.map(runCheck));
}

async function readHistory(env) {
  const out = {};
  for (const svc of SERVICES) out[svc.id] = [];
  let cursor;
  let pages = 0;
  do {
    const list = await env.STATUS_KV.list({ prefix: "h:", limit: 1000, cursor });
    const docs = await Promise.all(list.keys.map((k) => env.STATUS_KV.get(k.name, { type: "json" })));
    for (const doc of docs) {
      if (!doc) continue;
      for (const r of doc.results || []) {
        if (out[r.id]) out[r.id].push({ ok: r.ok, ms: r.ms, at: doc.at });
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
    pages++;
  } while (cursor && pages < 12);
  return out;
}

function statusOverall(results) {
  const total = results.length;
  const down = results.filter((r) => !r.ok).length;
  if (down === 0) return { label: "All systems operational", state: "up" };
  if (down === total) return { label: "Major outage", state: "major" };
  return {
    label: `Partial outage — ${down} service${down > 1 ? "s" : ""} degraded`,
    state: "partial",
  };
}

function fmtMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function dailyBuckets(samples) {
  const today = Math.floor(Date.now() / DAY_MS);
  const buckets = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const dayIndex = today - i;
    const dayStart = dayIndex * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const inDay = samples.filter((s) => s.at >= dayStart && s.at < dayEnd);
    const total = inDay.length;
    const up = inDay.filter((s) => s.ok).length;
    const uptime = total ? (up / total) * 100 : null;
    const date = new Date(dayStart);
    buckets.push({
      dayIndex,
      iso: date.toISOString().slice(0, 10),
      label: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      uptime,
      samples: total,
      incidents: total - up,
      hasData: total > 0,
    });
  }
  return buckets;
}

function tier(uptime) {
  if (uptime == null) return "nodata";
  if (uptime >= 99.9) return "ok";
  if (uptime >= 99) return "warn";
  if (uptime >= 95) return "deg";
  return "bad";
}

function dailyBarsHtml(buckets) {
  return buckets
    .map((b) => {
      const t = tier(b.uptime);
      const tooltip = b.hasData
        ? `${b.label} · ${b.uptime.toFixed(2)}% uptime${b.incidents ? ` · ${b.incidents} incident${b.incidents > 1 ? "s" : ""}` : ""}`
        : `${b.label} · No data`;
      return `<span class="day ${t}" title="${esc(tooltip)}"></span>`;
    })
    .join("");
}

function overallUptime(buckets) {
  const withData = buckets.filter((b) => b.hasData);
  if (!withData.length) return null;
  return withData.reduce((s, b) => s + b.uptime, 0) / withData.length;
}

function renderPage(results, history) {
  const groups = {};
  for (const svc of SERVICES) (groups[svc.group] = groups[svc.group] || []).push(svc);
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  const overall = statusOverall(results);
  const generatedAt = new Date().toUTCString();

  const groupHtml = Object.entries(groups)
    .map(([gname, svcs]) => {
      const rows = svcs
        .map((svc) => {
          const r = byId[svc.id];
          const samples = history[svc.id] || [];
          const buckets = dailyBuckets(samples);
          const cls = r.ok ? "ok" : "down";
          const dotLabel = r.ok ? "Operational" : "Down";
          const note = r.ok ? fmtMs(r.ms) : esc(r.reason || "Error");
          const avg = overallUptime(buckets);
          return `
        <article class="svc ${cls}">
          <div class="svc-head">
            <div class="svc-meta">
              <div class="svc-title">${esc(svc.name)}</div>
              <div class="svc-desc">${esc(svc.desc)}</div>
            </div>
            <div class="svc-status">
              <div class="pill ${cls}">${dotLabel}</div>
              <div class="micro">${note}</div>
            </div>
          </div>
          <div class="svc-graph">
            <div class="days">${dailyBarsHtml(buckets)}</div>
            <div class="axis">
              <span>${HISTORY_DAYS} days ago</span>
              <span class="avg">${avg == null ? "Collecting data…" : `${avg.toFixed(2)}% uptime`}</span>
              <span>Today</span>
            </div>
          </div>
        </article>`;
        })
        .join("");
      return `<section class="group"><h2>${esc(gname)}</h2><div class="svc-stack">${rows}</div></section>`;
    })
    .join("");

  const refreshSeconds = TICK_MINUTES * 60;
  const cadenceCopy =
    TICK_MINUTES === 1 ? "every minute" : `every ${TICK_MINUTES} minutes`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Prismonic — System Status</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta http-equiv="refresh" content="${refreshSeconds}"/><link rel="icon" href="https://prismonic.com/logo.webp"/>
<style>
:root{--gray-50:#F9FAFB;--gray-100:#F3F4F6;--gray-200:#E5E7EB;--gray-300:#D1D5DB;--gray-400:#9CA3AF;--gray-500:#6B7280;--gray-700:#374151;--gray-900:#111827;--blue-500:#3B82F6;--blue-600:#2563EB;--blue-700:#1D4ED8;--blue-50:#EFF6FF;--green-500:#22C55E;--green-600:#16A34A;--green-50:#DCFCE7;--yellow-500:#FACC15;--orange-500:#F97316;--red-500:#EF4444;--red-600:#DC2626;--red-50:#FEE2E2;--container:1100px;--container-pad:24px}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:white;color:var(--gray-900);font-family:-apple-system,BlinkMacSystemFont,"Inter",system-ui,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.container{max-width:var(--container);margin:0 auto;padding:0 var(--container-pad)}
.topnav{position:sticky;top:0;z-index:50;background:rgba(255,255,255,0.85);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid rgba(229,231,235,0.65)}
.nav-inner{padding-top:14px;padding-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:18px}
.nav-brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;letter-spacing:-0.025em;color:var(--gray-900)}
.nav-brand img{width:32px;height:32px;object-fit:contain;display:block}
.nav-brand .status-tag{margin-left:6px;font-size:9px;letter-spacing:0.18em;font-weight:700;text-transform:uppercase;color:var(--gray-400);padding:2px 7px;border:1px solid var(--gray-200);border-radius:5px}
.nav-actions{display:flex;align-items:center;gap:14px}
.nav-live{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:700;letter-spacing:0.18em;color:var(--green-600);background:var(--green-50);padding:5px 10px;border-radius:999px;text-transform:uppercase}
.nav-live::before{content:"";width:6px;height:6px;border-radius:999px;background:var(--green-500);animation:livepulse 1.6s infinite}
@keyframes livepulse{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,0.55)}50%{box-shadow:0 0 0 6px rgba(34,197,94,0)}}
.nav-link{font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:var(--gray-500);transition:color .14s}
.nav-link:hover{color:var(--blue-600)}
.nav-cta{font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:white;background:var(--blue-600);padding:9px 16px;border-radius:8px;transition:background-color .14s}
.nav-cta:hover{background:var(--blue-700)}
.hero{position:relative;overflow:hidden;border-bottom:1px solid var(--gray-200);background:linear-gradient(180deg,#EFF6FF 0%,#F8FAFF 60%,white 100%)}
.hero::before{content:"";position:absolute;inset:0;background-image:radial-gradient(circle at 1px 1px,rgba(37,99,235,0.16) 1px,transparent 0);background-size:24px 24px;mask-image:linear-gradient(180deg,black 0%,black 65%,transparent 100%);-webkit-mask-image:linear-gradient(180deg,black 0%,black 65%,transparent 100%);pointer-events:none}
.hero::after{content:"";position:absolute;top:-180px;right:-140px;width:560px;height:560px;border-radius:999px;background:radial-gradient(circle,rgba(59,130,246,0.22),transparent 60%);pointer-events:none}
.hero-inner{position:relative;padding-top:60px;padding-bottom:52px}
.hero-eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:var(--blue-600);background:white;border:1px solid rgba(59,130,246,0.25);padding:6px 12px;border-radius:999px;margin-bottom:18px}
.hero-eyebrow::before{content:"";width:6px;height:6px;border-radius:999px;background:var(--blue-500)}
.hero h1{font-size:44px;line-height:1.04;margin:0 0 14px;letter-spacing:-0.035em;font-weight:800;color:var(--gray-900)}
.hero p.subline{margin:0;color:var(--gray-500);font-size:14px;max-width:580px;line-height:1.55}
.overall-card{margin-top:28px;display:inline-flex;align-items:center;gap:14px;padding:14px 20px;background:white;border:1px solid var(--gray-200);border-radius:14px;box-shadow:0 10px 28px -16px rgba(15,23,42,0.15)}
.overall-card.up{border-color:rgba(34,197,94,0.35);background:linear-gradient(180deg,#F0FDF4 0%,white 70%)}
.overall-card.partial{border-color:rgba(250,204,21,0.55);background:linear-gradient(180deg,#FEFCE8 0%,white 70%)}
.overall-card.major{border-color:rgba(239,68,68,0.55);background:linear-gradient(180deg,#FEF2F2 0%,white 70%)}
.ind{width:12px;height:12px;border-radius:999px;flex-shrink:0}
.ind.up{background:var(--green-500);box-shadow:0 0 0 6px rgba(34,197,94,0.10);animation:dotpulse 2.4s infinite}
.ind.partial{background:#F59E0B;box-shadow:0 0 0 6px rgba(245,158,11,0.10)}
.ind.major{background:var(--red-500);box-shadow:0 0 0 6px rgba(239,68,68,0.12)}
@keyframes dotpulse{0%,100%{box-shadow:0 0 0 6px rgba(34,197,94,0.06)}50%{box-shadow:0 0 0 8px rgba(34,197,94,0.18)}}
.overall-text .lbl{display:block;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:var(--gray-400)}
.overall-text .val{display:block;font-size:15px;font-weight:700;color:var(--gray-900);margin-top:2px}
.body-inner{padding-top:36px;padding-bottom:80px}
.group{margin-top:28px}
.group:first-child{margin-top:0}
.group h2{font-size:10px;text-transform:uppercase;letter-spacing:0.18em;color:var(--gray-500);font-weight:700;margin:0 0 12px;padding-left:4px}
.svc-stack{display:flex;flex-direction:column;gap:12px}
.svc{background:white;border-radius:14px;padding:18px 22px;border:1px solid var(--gray-200);transition:border-color .18s,box-shadow .18s}
.svc:hover{box-shadow:0 6px 24px -12px rgba(15,23,42,0.10)}
.svc.down{border-color:#FECACA;background:linear-gradient(180deg,#FEF2F2 0%,white 22%)}
.svc-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}
.svc-meta{min-width:0}
.svc-title{font-weight:700;font-size:15px;color:var(--gray-900);letter-spacing:-0.005em}
.svc-desc{color:var(--gray-500);font-size:12px;margin-top:2px;font-variant-numeric:tabular-nums}
.svc-status{text-align:right;white-space:nowrap}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-weight:700;font-size:11px;letter-spacing:0.04em}
.pill::before{content:"";width:7px;height:7px;border-radius:999px}
.pill.ok{background:var(--green-50);color:var(--green-600)}.pill.ok::before{background:var(--green-500)}
.pill.down{background:var(--red-50);color:var(--red-600)}.pill.down::before{background:var(--red-500)}
.micro{font-size:11px;color:var(--gray-500);margin-top:4px;font-variant-numeric:tabular-nums}
.svc-graph{margin-top:6px}
.days{display:flex;gap:2px;align-items:stretch;height:34px}
.day{flex:1;border-radius:3px;background:var(--gray-200);transition:opacity .18s;cursor:help}
.day:hover{opacity:0.75}
.day.ok{background:var(--green-500)}.day.warn{background:var(--yellow-500)}.day.deg{background:var(--orange-500)}.day.bad{background:var(--red-500)}
.day.nodata{background:var(--gray-100);border:1px dashed var(--gray-300);box-sizing:border-box}
.axis{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--gray-400);margin-top:8px}
.axis .avg{font-weight:700;color:var(--gray-500);font-variant-numeric:tabular-nums}
footer{margin-top:56px;text-align:center;color:var(--gray-400);font-size:12px}
footer a{color:var(--blue-600);text-decoration:none;font-weight:600}
.legend{display:flex;gap:18px;justify-content:center;font-size:11px;color:var(--gray-500);margin-bottom:14px;flex-wrap:wrap}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:9px;height:9px;display:inline-block;border-radius:2px}
@media (max-width:640px){:root{--container-pad:16px}.nav-actions .nav-link{display:none}.nav-brand .status-tag{display:none}.hero-inner{padding-top:42px;padding-bottom:38px}.hero h1{font-size:28px}.hero p.subline{font-size:13px}.body-inner{padding-top:24px;padding-bottom:60px}.svc{padding:16px 18px}.days{height:28px}}
</style></head>
<body>
<nav class="topnav">
  <div class="container nav-inner">
    <a class="nav-brand" href="https://prismonic.com">
      <img src="https://prismonic.com/logo.webp" alt="Prismonic" width="32" height="32" />
      Prismonic<span class="status-tag">Status</span>
    </a>
    <div class="nav-actions">
      <span class="nav-live">Live</span>
      <a class="nav-link" href="/api/status">API</a>
      <a class="nav-cta" href="https://prismonic.com">Visit site</a>
    </div>
  </div>
</nav>
<section class="hero">
  <div class="container hero-inner">
    <div class="hero-eyebrow">System Status · Last ${HISTORY_DAYS} days</div>
    <h1>How are Prismonic services doing?</h1>
    <p class="subline">Live health of every Prismonic API, web app, and the radio stream. Checks run ${cadenceCopy} · Page auto-refreshes ${cadenceCopy} · Generated ${esc(generatedAt)}</p>
    <div class="overall-card ${overall.state}">
      <span class="ind ${overall.state}"></span>
      <div class="overall-text">
        <span class="lbl">Current status</span>
        <span class="val">${esc(overall.label)}</span>
      </div>
    </div>
  </div>
</section>
<div class="container body-inner">
  <main>${groupHtml}</main>
  <footer>
    <div class="legend">
      <span><i style="background:var(--green-500)"></i> ≥99.9%</span>
      <span><i style="background:var(--yellow-500)"></i> ≥99%</span>
      <span><i style="background:var(--orange-500)"></i> ≥95%</span>
      <span><i style="background:var(--red-500)"></i> &lt;95%</span>
      <span><i style="background:var(--gray-100);border:1px dashed var(--gray-300)"></i> No data</span>
    </div>
    <div>Built for <a href="https://prismonic.com">prismonic.com</a> · Powered by Cloudflare Workers</div>
  </footer>
</div>
</body></html>`;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/status") {
      const results = await runAll();
      return new Response(
        JSON.stringify({ overall: statusOverall(results), results, at: Date.now() }, null, 2),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } }
      );
    }
    const [results, history] = await Promise.all([runAll(), readHistory(env)]);
    return new Response(renderPage(results, history), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, max-age=0" },
    });
  },

  async scheduled(event, env, ctx) {
    const results = await runAll();
    const at = Date.now();
    const key = "h:" + String(at).padStart(15, "0");
    await env.STATUS_KV.put(key, JSON.stringify({ at, results }), {
      expirationTtl: 60 * 60 * 24 * 7,
    });
    const prevState = (await env.STATUS_KV.get("state:last", { type: "json" })) || null;
    const nextState = {};
    for (const r of results) nextState[r.id] = r.ok;
    await env.STATUS_KV.put("state:last", JSON.stringify(nextState));
    if (!prevState) return;
    const changes = [];
    for (const r of results) {
      const wasUp = prevState[r.id];
      if (wasUp === undefined) continue;
      if (wasUp !== r.ok) {
        const svc = SERVICES.find((s) => s.id === r.id);
        changes.push({
          service: svc?.name || r.id,
          id: r.id,
          url: svc?.url || "",
          previousState: wasUp ? "up" : "down",
          newState: r.ok ? "up" : "down",
          reason: r.reason || "",
        });
      }
    }
    if (changes.length && env.ALERT_ENDPOINT && env.ALERT_SECRET) {
      try {
        await fetch(env.ALERT_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Status-Alert-Secret": env.ALERT_SECRET,
          },
          body: JSON.stringify({ changes }),
        });
      } catch (e) {
        console.log("status-alert post failed:", e && e.message);
      }
    }
  },
};
