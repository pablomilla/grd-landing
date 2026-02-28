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

function upliftMultiplier(grade) {
  // conservative uplift curve (tune later)
  if (grade >= 10) return 3.0;
  if (grade >= 9.5) return 1.9;
  if (grade >= 9.0) return 1.35;
  if (grade >= 8.5) return 1.12;
  if (grade >= 8.0) return 1.08;
  return 1.02;
}

// ---------- FX (ECB, EUR base) ----------
async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
  }
}

// ECB daily XML: EUR base. Includes USD/GBP etc.
async function getFX_ECB(debug) {
  const url = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
  debug.fx = debug.fx || {};
  debug.fx.source = url;

  const r = await fetchWithTimeout(url, { method: "GET" }, 12000);
  debug.fx.http = r.status;

  if (!r.ok) throw new Error(`FX failed (HTTP ${r.status})`);

  const xml = await r.text();

  // very small XML parse (regex): <Cube currency='USD' rate='1.09'/>
  const getRate = (ccy) => {
    const m = xml.match(new RegExp(`currency=['"]${ccy}['"]\\s+rate=['"]([0-9.]+)['"]`));
    return m ? Number(m[1]) : null;
  };

  const USD = getRate("USD");
  const GBP = getRate("GBP");
  const EUR = 1;

  if (!USD || !GBP) throw new Error("FX failed (missing USD/GBP rates)");

  return { base: "EUR", EUR, USD, GBP };
}

function convert(amount, from, to, rates) {
  if (amount == null || !isFinite(amount)) return null;
  if (from === to) return amount;

  // rates are EUR->CCY
  const toEUR = (amt, ccy) => {
    if (ccy === "EUR") return amt;
    if (ccy === "USD") return amt / rates.USD;
    if (ccy === "GBP") return amt / rates.GBP;
    return amt;
  };
  const fromEUR = (amt, ccy) => {
    if (ccy === "EUR") return amt;
    if (ccy === "USD") return amt * rates.USD;
    if (ccy === "GBP") return amt * rates.GBP;
    return amt;
  };

  const eur = toEUR(amount, from);
  return fromEUR(eur, to);
}

function normalizeGameForJustTCG(game) {
  const g = String(game || "").toLowerCase();
  if (g === "pokemon") return "pokemon";
  if (g === "mtg" || g.includes("magic")) return "magic-the-gathering";
  if (g === "yugioh" || g.includes("yu")) return "yugioh";
  return null;
}

// ---------- JustTCG lookup ----------
async function justTCGSearchCard(card, debug) {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return { picked: null, rawUSD: null, currency: null, note: "Missing JUSTTCG_API_KEY" };

  const game = normalizeGameForJustTCG(card?.game);
  if (!game) return { picked: null, rawUSD: null, currency: null, note: "Unsupported game for JustTCG" };

  // Build a reasonable query. Keep it simple; JustTCG does broad search.
  const name = card?.name ? String(card.name).trim() : "";
  const setName = card?.set ? String(card.set).trim() : "";
  const number = card?.collectorNumber ? String(card.collectorNumber).trim() : "";

  // If you put too much in q, you can get 0 results. Start simple.
  // We'll score results afterwards using set/number.
  const q = [name, setName].filter(Boolean).join(" ").trim() || name;
  if (!q) return { picked: null, rawUSD: null, currency: null, note: "Missing card name" };

  const BASE = "https://api.justtcg.com/v1";
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("game", game);
  // Reduce variants returned to keep payload smaller & stable:
  params.set("condition", "Near Mint");
  params.set("printing", "Normal");
  params.set("limit", "25");
  params.set("offset", "0");
  params.set("include_price_history", "false");
  params.set("include_statistics", "30d");

  const url = `${BASE}/cards?${params.toString()}`;

  debug.justtcg = debug.justtcg || {};
  debug.justtcg.url = url;
  debug.justtcg.q = q;
  debug.justtcg.game = game;

  const r = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
    },
    15000
  );

  debug.justtcg.http = r.status;

  const j = await r.json().catch(() => ({}));
  const data = Array.isArray(j?.data) ? j.data : [];
  debug.justtcg.count = data.length;

  if (!r.ok) {
    debug.justtcg.error = j?.error?.message || j?.message || `HTTP ${r.status}`;
    return { picked: null, rawUSD: null, currency: null, note: "JustTCG request failed" };
  }

  if (!data.length) return { picked: null, rawUSD: null, currency: null, note: "No matches from JustTCG" };

  // Score matches using name/set/number (best-effort)
  const safeLower = (s) => String(s || "").toLowerCase();
  const wantName = safeLower(name);
  const wantSet = safeLower(setName);
  const wantNum = safeLower(number);

  function score(c) {
    let s = 0;
    const cName = safeLower(c?.name);
    const cSet = safeLower(c?.set_name);
    const cNum = safeLower(c?.number);

    if (wantName && cName.includes(wantName)) s += 10;
    if (wantSet && cSet.includes(wantSet)) s += 4;
    if (wantNum && cNum === wantNum) s += 6;
    if (c?.tcgplayerId) s += 1;

    // prefer priced variants
    const v = Array.isArray(c?.variants) ? c.variants[0] : null;
    if (v && isFinite(Number(v.price))) s += 2;

    return s;
  }

  const ranked = [...data].sort((a, b) => score(b) - score(a));
  const picked = ranked[0];

  // Variants structure: every card has at least 1 variant; with our filters
  // variants[0].price is "Current price in USD" (JustTCG docs).
  const v0 = Array.isArray(picked?.variants) ? picked.variants[0] : null;
  const rawUSD = v0 && isFinite(Number(v0.price)) ? Number(v0.price) : null;

  debug.justtcg.picked = picked
    ? {
        id: picked.id,
        name: picked.name,
        set_name: picked.set_name,
        number: picked.number,
        tcgplayerId: picked.tcgplayerId,
        variant: v0 ? { condition: v0.condition, printing: v0.printing, price: v0.price } : null,
      }
    : null;

  if (rawUSD == null) return { picked, rawUSD: null, currency: null, note: "No USD price in picked variant" };

  return { picked, rawUSD, currency: "USD", note: null };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  const debug = { justtcg: {}, fx: {} };

  try {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const { card, distribution, feeGBP } = await readBody(req);
    if (!card?.game || !card?.name) return json(res, 400, { error: "Missing card" });

    const fee = isFinite(Number(feeGBP)) ? Number(feeGBP) : 15;

    // 1) Get USD raw from JustTCG
    const live = await justTCGSearchCard(card, debug);

    if (!live.rawUSD) {
      return json(res, 200, {
        source: null,
        raw: null,
        currency: null,
        note: "Live pricing unavailable. Use manual raw override.",
        debug,
      });
    }

    // 2) Compute EV graded in USD using uplift curve + distribution
    const dist = Array.isArray(distribution) && distribution.length
      ? distribution
      : [
          { grade: 8.5, prob: 0.2 },
          { grade: 9.0, prob: 0.5 },
          { grade: 9.5, prob: 0.25 },
          { grade: 10.0, prob: 0.05 },
        ];

    let evGradedUSD = 0;
    let sumP = 0;
    for (const g of dist) {
      const grade = clamp(Number(g.grade || 9), 1, 10);
      const prob = Math.max(0, Number(g.prob || 0));
      sumP += prob;
      evGradedUSD += prob * (live.rawUSD * upliftMultiplier(grade));
    }
    if (sumP > 0 && Math.abs(sumP - 1) > 0.02) {
      // normalize if caller didn't send a normalized distribution
      evGradedUSD = evGradedUSD / sumP;
    }

    // 3) FX convert to GBP/EUR/USD
    const fx = await getFX_ECB(debug);

    const out = {
      source: "JustTCG",
      raw: live.rawUSD,
      currency: "USD",
      evGraded: evGradedUSD,
      upliftModel: "conservative",
      fx: { base: fx.base, GBP: fx.GBP, USD: fx.USD },
      converted: {},
      debug,
    };

    for (const ccy of ["GBP", "EUR", "USD"]) {
      const rawC = convert(live.rawUSD, "USD", ccy, fx);
      const evC = convert(evGradedUSD, "USD", ccy, fx);
      const feeC = convert(fee, "GBP", ccy, fx);
      out.converted[ccy] = { raw: rawC, evGraded: evC, fee: feeC };
    }

    return json(res, 200, out);
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e?.message || "Pricing failed", debug });
  }
}