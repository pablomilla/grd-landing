// /api/price.js
export const config = { runtime: "nodejs" };

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, cancel: () => clearTimeout(t) };
}

// Conservative uplift curve (tune later)
function upliftMultiplier(grade) {
  if (grade >= 10) return 3.0;
  if (grade >= 9.5) return 1.9;
  if (grade >= 9.0) return 1.35;
  if (grade >= 8.5) return 1.12;
  if (grade >= 8.0) return 1.08;
  return 1.02;
}

// ECB FX (EUR base). Fallback if ECB is unavailable.
async function getFX(debug) {
  // ECB daily XML
  const url = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

  // fallback rates (EUR base) — only used if ECB fails
  const fallback = { base: "EUR", GBP: 0.86, USD: 1.08 };

  try {
    const { signal, cancel } = withTimeout(6500);
    const r = await fetch(url, { signal });
    cancel();

    debug.fx = debug.fx || {};
    debug.fx.url = url;
    debug.fx.http = r.status;

    if (!r.ok) throw new Error(`ECB HTTP ${r.status}`);

    const xml = await r.text();

    // Parse: currency='USD' rate='1.0'
    const pick = (ccy) => {
      const re = new RegExp(`currency=['"]${ccy}['"]\\s+rate=['"]([0-9.]+)['"]`, "i");
      const m = xml.match(re);
      return m ? Number(m[1]) : null;
    };

    const USD = pick("USD");
    const GBP = pick("GBP");

    if (!USD || !GBP) throw new Error("ECB parse failed");

    return { base: "EUR", GBP, USD };
  } catch (e) {
    debug.fx = debug.fx || {};
    debug.fx.error = e?.message || "FX failed";
    return fallback;
  }
}

// Convert between currencies using ECB rates (EUR base)
function convert(amount, from, to, rates) {
  if (amount == null || !isFinite(amount)) return null;
  if (from === to) return amount;

  const toEUR = (amt, ccy) => {
    if (ccy === "EUR") return amt;
    if (ccy === "GBP") return amt / rates.GBP;
    if (ccy === "USD") return amt / rates.USD;
    return amt;
  };

  const fromEUR = (amt, ccy) => {
    if (ccy === "EUR") return amt;
    if (ccy === "GBP") return amt * rates.GBP;
    if (ccy === "USD") return amt * rates.USD;
    return amt;
  };

  return fromEUR(toEUR(amount, from), to);
}

// --- JustTCG (primary) ---
// Uses x-api-key header.  [oai_citation:1‡JustTCG](https://justtcg.com/blog/your-first-call-integrating-justtcg-pricing-data-in-minutes?utm_source=chatgpt.com)
async function justTCGPrice(card, debug) {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) {
    debug.justtcg = { error: "Missing JUSTTCG_API_KEY" };
    return null;
  }

  // Build a query string: name + set + number (best-effort)
  const parts = [];
  if (card.name) parts.push(String(card.name));
  if (card.set) parts.push(String(card.set));
  if (card.collectorNumber) parts.push(String(card.collectorNumber));
  const q = parts.join(" ").trim();
  if (!q) return null;

  // Map internal game -> JustTCG game param (best guess)
  const game =
    card.game === "pokemon" ? "Pokemon" :
    card.game === "mtg" ? "Magic" :
    card.game === "yugioh" ? "YuGiOh" :
    null;

  // JustTCG docs/blog examples: /v1/cards?q=...  [oai_citation:2‡JustTCG](https://justtcg.com/blog/from-zero-to-search-build-a-live-tcg-card-finder-with-the-justtcg-api?utm_source=chatgpt.com)
  const url =
    "https://api.justtcg.com/v1/cards?" +
    new URLSearchParams({
      q,
      ...(game ? { game } : {}),
      condition: "NM",
      printing: "Normal",
      include_price_history: "false",
      include_statistics: "30d",
    }).toString();

  debug.justtcg = { url, q, game };

  try {
    const { signal, cancel } = withTimeout(8000);
    const r = await fetch(url, {
      method: "GET",
      signal,
      headers: {
        "x-api-key": apiKey,        // ✅ correct auth header
        "accept": "application/json"
      }
    });
    cancel();

    debug.justtcg.http = r.status;

    const j = await r.json().catch(() => ({}));
    const data = Array.isArray(j?.data) ? j.data : [];

    debug.justtcg.count = data.length;

    if (!r.ok) {
      debug.justtcg.error = j?.error?.message || j?.message || `HTTP ${r.status}`;
      return null;
    }

    if (!data.length) return null;

    // Try to pick a sane raw market price from common shapes.
    // (We don’t know your exact plan payload; this is defensive.)
    const item = data[0];

    // Look for likely fields:
    const candidates = [
      item?.market?.price,
      item?.marketPrice,
      item?.price,
      item?.statistics?.market?.median,
      item?.statistics?.market?.mean,
      item?.statistics?.median,
      item?.statistics?.mean,
      item?.pricing?.market,
      item?.pricing?.mid,
      item?.pricing?.low,
    ]
      .map((v) => Number(v))
      .filter((v) => isFinite(v) && v > 0);

    const raw = candidates.length ? candidates[0] : null;

    debug.justtcg.picked = raw;

    if (!raw) return null;

    // Assume EUR if not stated. If your payload includes currency, map it here.
    const currency = (item?.currency || "EUR").toUpperCase();
    const safeCurrency = ["EUR", "GBP", "USD"].includes(currency) ? currency : "EUR";

    return { source: "JustTCG", currency: safeCurrency, raw };
  } catch (e) {
    debug.justtcg.http = "FETCH_ERR";
    debug.justtcg.error = e?.name === "AbortError" ? "Timeout" : (e?.message || "Fetch error");
    return null;
  }
}

export default async function handler(req, res) {
  const debug = {};
  try {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const { card, distribution, feeGBP } = await readBody(req);
    if (!card?.game || !card?.name) return json(res, 400, { error: "Missing card" });

    const live = await justTCGPrice(card, debug);

    if (!live) {
      return json(res, 200, {
        source: null,
        raw: null,
        currency: null,
        note: "Live pricing unavailable. Use manual raw override.",
        debug
      });
    }

    const dist = Array.isArray(distribution) && distribution.length
      ? distribution
      : [
          { grade: 8.5, prob: 0.2 },
          { grade: 9.0, prob: 0.5 },
          { grade: 9.5, prob: 0.25 },
          { grade: 10.0, prob: 0.05 },
        ];

    let evGraded = 0;
    for (const g of dist) {
      const grade = clamp(Number(g.grade || 9), 1, 10);
      const prob = Math.max(0, Number(g.prob || 0));
      evGraded += prob * (live.raw * upliftMultiplier(grade));
    }

    const fx = await getFX(debug);

    const fee = isFinite(Number(feeGBP)) ? Number(feeGBP) : 15;

    const out = {
      source: live.source,
      raw: live.raw,
      currency: live.currency,
      evGraded,
      upliftModel: "conservative",
      fx,
      converted: {},
      debug
    };

    for (const ccy of ["GBP", "EUR", "USD"]) {
      const rawC = convert(live.raw, live.currency, ccy, fx);
      const evC = convert(evGraded, live.currency, ccy, fx);
      const feeC = convert(fee, "GBP", ccy, fx);
      out.converted[ccy] = { raw: rawC, evGraded: evC, fee: feeC };
    }

    return json(res, 200, out);
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e?.message || "Pricing failed", debug });
  }
}