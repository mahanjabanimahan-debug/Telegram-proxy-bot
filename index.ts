// Telegram MTProto proxy bot — standalone (Railway-ready)
// Collects proxies from public channels/APIs, TCP-tests them, and posts working ones every 5 minutes.
import net from "node:net";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---- Config (via environment variables) ----
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHANNEL = process.env.CHANNEL || "@Telgram_proxy963";
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN || "5");
const MAX_POST = Number(process.env.MAX_POST || "6");
const TCP_TIMEOUT = 4000;
const POSTED_FILE = "/tmp/posted.json";

// Source channels (public) and APIs. Edit freely.
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

function extractProxies(text: string): Proxy[] {
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

async function collect(): Promise<Proxy[]> {
  const all: Proxy[] = [];
  const chTasks = SOURCE_CHANNELS.map(async (ch) =>
    extractProxies(await fetchText(`https://t.me/s/${ch}`)),
  );
  const apiTasks = SOURCE_APIS.map(async (url) => {
    const body = await fetchText(url);
    try {
      const data = JSON.parse(body);
      if (Array.isArray(data))
        return data
          .filter((x: any) => x.host && x.port && x.secret)
          .map((x: any) => ({
            server: String(x.host),
            port: Number(x.port),
            secret: String(x.secret),
          }));
    } catch {}
    return extractProxies(body);
  });
  for (const list of await Promise.all([...chTasks, ...apiTasks]))
    all.push(...list);
  const seen = new Set<string>();
  return all.filter((p) => (seen.has(key(p)) ? false : (seen.add(key(p)), true)));
}

function tcpAlive(host: string, port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = net.connect({ host, port, timeout: TCP_TIMEOUT });
    sock.on("connect", () => {
      sock.destroy();
      resolve(Date.now() - start);
    });
    const fail = () => {
      sock.destroy();
      resolve(null);
    };
    sock.on("error", fail);
    sock.on("timeout", fail);
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

    const alive: { p: Proxy; ms: number }[] = [];
    const batch = 20;
    for (let i = 0; i < fresh.length && alive.length < MAX_POST * 3; i += batch) {
      const res = await Promise.all(
        fresh.slice(i, i + batch).map(async (p) => ({
          p,
          ms: await tcpAlive(p.server, p.port),
        })),
      );
      for (const r of res) if (r.ms !== null) alive.push(r as any);
    }
    alive.sort((a, b) => a.ms - b.ms);
    const toPost = alive.slice(0, MAX_POST);
    console.log(
      `[${new Date().toISOString()}] collected=${proxies.length} fresh=${fresh.length} alive=${alive.length} posting=${toPost.length}`,
    );
    if (toPost.length === 0) return;

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
