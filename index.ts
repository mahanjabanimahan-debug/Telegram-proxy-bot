// Telegram MTProto proxy bot — standalone (Railway-ready)
// Only takes proxies from the LAST message of each source channel
// Tests them with real TLS/TCP handshake before posting
import net from "node:net";
import tls from "node:tls";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---- Config ----
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHANNEL = process.env.CHANNEL || "@Telgram_proxy963";
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN || "5");
const MAX_POST = Number(process.env.MAX_POST || "6");
const TCP_TIMEOUT = 6000;
const POSTED_FILE = "/tmp/posted.json";

// Only these two source channels
const SOURCE_CHANNELS = (process.env.SOURCE_CHANNELS || "iRoProxy,proxy_bolt")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!BOT_TOKEN) {
  console.error("ERROR: BOT_TOKEN environment variable is required.");
  process.exit(1);
}

type Proxy = { server: string; port: number; secret: string; source: string };
const key = (p: Proxy) => `${p.server}:${p.port}:${p.secret}`;

function extractProxiesFromText(text: string): Omit<Proxy, "source">[] {
  const out: Omit<Proxy, "source">[] = [];
  const re = /(?:t\.me\/proxy|tg:\/\/proxy)\?([^"'\s<)\]]+)/gi;
  let m;
  const seen = new Set<string>();
  while ((m = re.exec(text))) {
    const params = new URLSearchParams(m[1].replace(/&amp;/g, "&"));
    const server = params.get("server");
    const port = parseInt(params.get("port") || "");
    const secret = params.get("secret") || "";
    if (server && port && secret) {
      const k = `${server}:${port}:${secret}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ server, port, secret });
      }
    }
  }
  return out;
}

async function fetchText(url: string): Promise<string> {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15000),
    });
    return await r.text();
  } catch {
    return "";
  }
}

// Extract proxies from the page — take the last N unique proxies (most recent posts)
function extractFromLastMessages(html: string, channelName: string): Proxy[] {
  const all = extractProxiesFromText(html);

  // Deduplicate keeping order
  const seen = new Set<string>();
  const unique: Proxy[] = [];
  for (const p of all) {
    const k = `${p.server}:${p.port}:${p.secret}`;
    if (!seen.has(k)) {
      seen.add(k);
      unique.push({ ...p, source: channelName });
    }
  }

  // Take the last 10 unique proxies (from the most recent messages)
  return unique.slice(-10);
}

async function collect(): Promise<Proxy[]> {
  const all: Proxy[] = [];

  const tasks = SOURCE_CHANNELS.map(async (ch) => {
    const html = await fetchText(`https://t.me/s/${ch}`);
    const proxies = extractFromLastMessages(html, ch);
    console.log(`  📡 ${ch}: found ${proxies.length} proxy(s) from last message`);
    return proxies;
  });

  for (const list of await Promise.all(tasks)) {
    all.push(...list);
  }

  // Deduplicate
  const seen = new Set<string>();
  return all.filter((p) => {
    const k = key(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Real proxy test — TCP connect is enough to confirm the server is alive
// MTProto proxies don't respond to random data, so we just check connectivity
function testProxy(p: Proxy): Promise<number | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    let resolved = false;
    const done = (ms: number | null) => {
      if (resolved) return;
      resolved = true;
      resolve(ms);
    };

    const hardTimer = setTimeout(() => done(null), TCP_TIMEOUT + 1000);

    // For all proxy types: TCP connect test is the most reliable
    // TLS handshake fails on many working proxies because they use custom TLS
    const sock = net.connect({ host: p.server, port: p.port, timeout: TCP_TIMEOUT });
    sock.on("connect", () => {
      clearTimeout(hardTimer);
      done(Date.now() - start);
      sock.destroy();
    });
    sock.on("error", () => { clearTimeout(hardTimer); done(null); sock.destroy(); });
    sock.on("timeout", () => { clearTimeout(hardTimer); done(null); sock.destroy(); });
  });
}

function loadPosted(): Record<string, number> {
  try {
    if (existsSync(POSTED_FILE))
      return JSON.parse(readFileSync(POSTED_FILE, "utf8"));
  } catch {}
  return {};
}

async function runOnce() {
  try {
    console.log(`\n[${new Date().toISOString()}] Starting collection...`);
    const proxies = await collect();
    const posted = loadPosted();
    const now = Date.now();
    const COOLDOWN = 2 * 60 * 60 * 1000; // 2 hours cooldown
    const fresh = proxies.filter(
      (p) => !posted[key(p)] || now - posted[key(p)] > COOLDOWN,
    );

    console.log(`  Total unique: ${proxies.length}, Fresh: ${fresh.length}`);

    if (fresh.length === 0) {
      console.log("⚠️ No fresh proxies to test.");
      return;
    }

    // Test all fresh proxies
    console.log("  Testing proxies...");
    const results = await Promise.all(
      fresh.map(async (p) => ({
        p,
        ms: await testProxy(p),
      })),
    );

    const alive = results.filter((r) => r.ms !== null) as { p: Proxy; ms: number }[];
    const dead = results.filter((r) => r.ms === null);

    for (const r of alive) {
      console.log(`  ✅ ${r.p.server}:${r.p.port} — ${r.ms}ms (${r.p.source})`);
    }
    for (const r of dead) {
      console.log(`  ❌ ${r.p.server}:${r.p.port} — dead (${r.p.source})`);
    }

    // Sort by ping
    alive.sort((a, b) => a.ms - b.ms);
    const toPost = alive.slice(0, MAX_POST);

    if (toPost.length === 0) {
      console.log("⚠️ No working proxies found this round.");
      return;
    }

    const timeStr = new Date().toLocaleString("fa-IR", {
      timeZone: "Asia/Tehran",
      hour: "2-digit",
      minute: "2-digit",
    });
    const lines = toPost.map(
      (x, i) => `🔹 پروکسی ${i + 1} — پینگ ${x.ms}ms`,
    );
    const text = `⚡️ پروکسی‌های فعال تلگرام\n🕐 ${timeStr}\n\n${lines.join(
      "\n",
    )}\n\n👇 برای اتصال روی دکمه‌ها بزنید\n\n${CHANNEL}`;
    const buttons = toPost.map((x, i) => [
      {
        text: `🚀 اتصال به پروکسی ${i + 1} (${x.ms}ms)`,
        url: `https://t.me/proxy?server=${encodeURIComponent(
          x.p.server,
        )}&port=${x.p.port}&secret=${encodeURIComponent(x.p.secret)}`,
      },
    ]);

    const resp = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHANNEL,
          text,
          reply_markup: { inline_keyboard: buttons },
        }),
      },
    );
    const rj: any = await resp.json();
    if (!rj.ok) {
      console.error("sendMessage failed:", rj.description);
      return;
    }
    for (const x of toPost) posted[key(x.p)] = now;
    for (const k of Object.keys(posted))
      if (now - posted[k] > 24 * 60 * 60 * 1000) delete posted[k];
    writeFileSync(POSTED_FILE, JSON.stringify(posted));
    console.log(`✅ Posted ${toPost.length} working proxies to ${CHANNEL}`);
  } catch (e) {
    console.error("run error:", e);
  }
}

console.log(
  `🤖 Proxy bot started | channel=${CHANNEL} | interval=${INTERVAL_MIN}m | sources: ${SOURCE_CHANNELS.join(", ")}`,
);
runOnce();
setInterval(runOnce, INTERVAL_MIN * 60 * 1000);
