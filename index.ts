// Telegram MTProto proxy bot — standalone (Railway-ready)
// Collects proxies from public channels/APIs, tests them properly, and posts working ones.
import net from "node:net";
import tls from "node:tls";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---- Config (via environment variables) ----
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHANNEL = process.env.CHANNEL || "@Telgram_proxy963";
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN || "5");
const MAX_POST = Number(process.env.MAX_POST || "6");
const TCP_TIMEOUT = 5000;
const POSTED_FILE = "/tmp/posted.json";

const SOURCE_CHANNELS = (process.env.SOURCE_CHANNELS ||
  "iRoProxy,ProxyMTProto,MTProxyT,iporoxy1")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SOURCE_APIS = (process.env.SOURCE_APIS ||
  "https://mtpro.xyz/api/?type=mtproto")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!BOT_TOKEN) {
  console.error("ERROR: BOT_TOKEN environment variable is required.");
  process.exit(1);
}

type Proxy = { server: string; port: number; secret: string };
const key = (p: Proxy) => `${p.server}:${p.port}`;

function extractProxies(text: string, maxCount = 10): Proxy[] {
  const out: Proxy[] = [];
  const re = /(?:t\.me\/proxy|tg:\/\/proxy)\?([^"'\s<)\]]+)/gi;
  let m;
  while ((m = re.exec(text))) {
    const params = new URLSearchParams(m[1].replace(/&amp;/g, "&"));
    const server = params.get("server");
    const port = parseInt(params.get("port") || "");
    const secret = params.get("secret") || "";
    if (server && port && secret) out.push({ server, port, secret });
  }
  // Return only the LAST N (most recent) proxies from each source
  return out.slice(-maxCount);
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

async function collect(): Promise<Proxy[]> {
  const all: Proxy[] = [];
  const chTasks = SOURCE_CHANNELS.map(async (ch) => {
    const html = await fetchText(`https://t.me/s/${ch}`);
    // Only take last 8 proxies per channel (freshest)
    return extractProxies(html, 8);
  });
  const apiTasks = SOURCE_APIS.map(async (url) => {
    const body = await fetchText(url);
    try {
      const data = JSON.parse(body);
      if (Array.isArray(data))
        return data
          .filter((x: any) => x.host && x.port && x.secret)
          .slice(-10)
          .map((x: any) => ({
            server: String(x.host),
            port: Number(x.port),
            secret: String(x.secret),
          }));
    } catch {}
    return extractProxies(body, 10);
  });
  for (const list of await Promise.all([...chTasks, ...apiTasks]))
    all.push(...list);
  const seen = new Set<string>();
  return all.filter((p) => (seen.has(key(p)) ? false : (seen.add(key(p)), true)));
}

// Real proxy test: for fake-TLS proxies (secret starts with ee/dd), do TLS handshake
// For others, do TCP + send bytes and check response
function testProxy(p: Proxy): Promise<number | null> {
  const isFakeTLS = p.secret.toLowerCase().startsWith("ee") || p.secret.toLowerCase().startsWith("dd");

  return new Promise((resolve) => {
    const start = Date.now();
    const timeout = TCP_TIMEOUT;

    if (isFakeTLS) {
      // Fake-TLS proxy: try TLS connection (these proxies speak TLS)
      const sock = tls.connect(
        { host: p.server, port: p.port, timeout, rejectUnauthorized: false },
        () => {
          // TLS handshake succeeded — proxy is alive and responding
          const ms = Date.now() - start;
          sock.destroy();
          resolve(ms);
        }
      );
      const fail = () => { sock.destroy(); resolve(null); };
      sock.on("error", fail);
      sock.on("timeout", fail);
      setTimeout(() => fail(), timeout);
    } else {
      // Regular MTProto: TCP connect + send a small payload to check response
      const sock = net.connect({ host: p.server, port: p.port, timeout });
      sock.on("connect", () => {
        // Send a dummy handshake byte to see if we get a response
        sock.write(Buffer.from([0xef]));
        const dataTimer = setTimeout(() => {
          // No response in 2s after connect — likely dead
          sock.destroy();
          resolve(null);
        }, 2000);
        sock.once("data", () => {
          clearTimeout(dataTimer);
          const ms = Date.now() - start;
          sock.destroy();
          resolve(ms);
        });
      });
      const fail = () => { sock.destroy(); resolve(null); };
      sock.on("error", fail);
      sock.on("timeout", fail);
      setTimeout(() => fail(), timeout);
    }
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
    const proxies = await collect();
    const posted = loadPosted();
    const now = Date.now();
    const COOLDOWN = 3 * 60 * 60 * 1000;
    const fresh = proxies.filter(
      (p) => !posted[key(p)] || now - posted[key(p)] > COOLDOWN,
    );

    console.log(`[${new Date().toISOString()}] collected=${proxies.length} fresh=${fresh.length}`);

    const alive: { p: Proxy; ms: number }[] = [];
    const batch = 10;
    for (let i = 0; i < fresh.length && alive.length < MAX_POST * 3; i += batch) {
      const res = await Promise.all(
        fresh.slice(i, i + batch).map(async (p) => ({
          p,
          ms: await testProxy(p),
        })),
      );
      for (const r of res) {
        if (r.ms !== null) {
          console.log(`  ✓ ${r.p.server}:${r.p.port} — ${r.ms}ms`);
          alive.push(r as any);
        } else {
          console.log(`  ✗ ${r.p.server}:${r.p.port} — dead`);
        }
      }
    }

    // Sort by ping, best first
    alive.sort((a, b) => a.ms - b.ms);
    const toPost = alive.slice(0, MAX_POST);
    console.log(`  alive=${alive.length} posting=${toPost.length}`);

    if (toPost.length === 0) {
      console.log("⚠️ No working proxies found this round.");
      return;
    }

    const timeStr = new Date().toLocaleString("fa-IR", {
      timeZone: "Asia/Tehran",
      hour: "2-digit",
      minute: "2-digit",
    });
    const lines = toPost.map((x, i) => `🔹 پروکسی ${i + 1} — پینگ ${x.ms}ms`);
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
    console.log(`✅ posted ${toPost.length} proxies to ${CHANNEL}`);
  } catch (e) {
    console.error("run error:", e);
  }
}

console.log(
  `Proxy bot started. channel=${CHANNEL} interval=${INTERVAL_MIN}m sources=${SOURCE_CHANNELS.length}ch/${SOURCE_APIS.length}api`,
);
runOnce();
setInterval(runOnce, INTERVAL_MIN * 60 * 1000);
