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

function normalizeCollectorNumber(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // "11/108" -> "11"
  if (s.includes("/")) return s.split("/")[0].trim();
  return s;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------- FX (ECB) ----------
async function getFX(debug) {
  const url = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
  debug.fx = debug.fx || {};
  debug.fx.url = url;

  const r = await fetchWithTimeout(url, {}, 9000);
  debug.fx.http = r.status;
  if (!r.ok) throw new Error(`ECB FX HTTP ${r.status}`);

  const xml = await r.text();

  const pick = (ccy) => {
    const re = new RegExp(`currency=['"]${ccy}['"]\\s+rate=['"]([0-9.]+)['"]`, "i");
    const m = xml.match(re);
    return m ? Number(m[1]) : null;
  };

  const USD = pick("USD");
  const GBP = pick("GBP");
  if (!USD || !GBP) throw new Error("ECB FX parse failed");

  return { base: "EUR", USD, GBP };
}

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

  const eur = toEUR(amount, from);
  return fromEUR(eur, to);
}

// ---------- ROI uplift model (placeholder; tune later) ----------
function upliftMultiplier(grade) {
  if (grade >= 10) return 3.0;
  if (grade >= 9.5) return 1.9;
  if (grade >= 9.0) return 1.35;
  if (grade >= 8.5) return 1.12;
  if (grade >= 8.0) return 1.08;
  return 1.02;
}

// ---------- JustTCG ----------
const JUSTTCG_BASE = "https://api.justtcg.com/v1";

function toJustTCGGameId(game) {
  const g = String(game || "").toLowerCase();
  if (g === "pokemon") return "pokemon";
  if (g === "mtg" || g.includes("magic")) return "mtg";
  if (g === "yugioh" || g.includes("yu")) return "yugioh";
  return null;
}

function desiredPrinting(variant) {
  const v = String(variant || "").toLowerCase();
  // JustTCG variants printing field is like "Normal", "Foil" (per docs examples)
  if (v.includes("foil") || v.includes("holo") || v.includes("reverse") || v.includes("etched"))
    return "Foil";
  return "Normal";
}

function scoreSetMatch(setObj, wantedSetName) {
  const n = String(setObj?.name || "").toLowerCase();
  const w = String(wantedSetName || "").toLowerCase();
  if (!w) return 0;
  if (n === w) return 10;
  if (n.includes(w) || w.includes(n)) return 6;
  // small token overlap
  const wn = new Set(w.split(/\s+/).filter(Boolean));
  const nn = n.split(/\s+/).filter(Boolean);
  let hit = 0;
  for (const t of nn) if (wn.has(t)) hit++;
  return hit;
}

async function justTCGGetSetId({ gameId, setName }, debug) {
  if (!setName) return null;

  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return null;

  const url = `${JUSTTCG_BASE}/sets?` + new URLSearchParams({ game: gameId, q: setName, limit: "25", offset: "0" });

  const r = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-api-key": apiKey, Accept: "application/json" },
  });

  const j = await r.json().catch(() => ({}));
  const list = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];

  debug.justtcg = debug.justtcg || {};
  debug.justtcg.setLookup = { url, http: r.status, count: list.length, error: r.ok ? null : (j?.message || j?.error || `HTTP ${r.status}`) };

  if (!r.ok || !list.length) return null;

  const ranked = [...list].sort((a, b) => scoreSetMatch(b, setName) - scoreSetMatch(a, setName));
  return ranked[0]?.id || null;
}

function pickVariantPrice(cardItem, wantPrinting, debug) {
  const variants = Array.isArray(cardItem?.variants) ? cardItem.variants : [];
  if (!variants.length) return null;

  // Prefer: wantPrinting + Near Mint, else wantPrinting, else any
  const norm = (s) => String(s || "").toLowerCase();

  const isNM = (v) => {
    const c = norm(v?.condition);
    // accept "Near Mint", "near-mint", "NM"
    return c.includes("near") || c === "nm" || c.includes("near-mint");
  };

  const printingOk = (v) => norm(v?.printing) === norm(wantPrinting);

  const priceOf = (v) => {
    // docs show variant has "price" in USD; sometimes "avgPrice"/etc exist too
    const p = Number(v?.price ?? v?.avgPrice ?? v?.marketPrice ?? v?.mid ?? v?.low);
    return isFinite(p) ? p : null;
  };

  const buckets = [
    variants.filter((v) => printingOk(v) && isNM(v)),
    variants.filter((v) => printingOk(v)),
    variants,
  ];

  for (const b of buckets) {
    let best = null;
    for (const v of b) {
      const p = priceOf(v);
      if (p == null) continue;
      if (!best || p > best.price) best = { price: p, variant: v };
    }
    if (best) {
      debug.justtcg.pickedVariant = {
        printing: best.variant?.printing || null,
        condition: best.variant?.condition || null,
        priceUSD: best.price,
        variantId: best.variant?.id || null,
      };
      return best.price;
    }
  }

  return null;
}

async function justTCGPriceUSD(card, debug) {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return { ok: false, reason: "Missing JUSTTCG_API_KEY" };

  const gameId = toJustTCGGameId(card?.game);
  if (!gameId) return { ok: false, reason: "Unsupported game" };

  const number = normalizeCollectorNumber(card?.collectorNumber);
  const setName = card?.set ? String(card.set).trim() : null;
  const name = card?.name ? String(card.name).trim() : null;
  if (!name) return { ok: false, reason: "Missing name" };

  debug.justtcg = debug.justtcg || {};
  debug.justtcg.gameId = gameId;

  const wantPrinting = desiredPrinting(card?.variant);

  // 1) Resolve set id (fast + accurate)
  const setId = setName ? await justTCGGetSetId({ gameId, setName }, debug) : null;

  // 2) Query cards endpoint using set+number when possible (fastest)
  const attempts = [];

  if (setId && number) {
    attempts.push({ game: gameId, set: setId, number, limit: "25", offset: "0", include_price_history: "false", include_statistics: "30d" });
  }
  if (setId) {
    attempts.push({ game: gameId, set: setId, q: name, limit: "25", offset: "0", include_price_history: "false", include_statistics: "30d" });
  }
  // last resort: text search
  attempts.push({ game: gameId, q: setName ? `${name} ${setName}` : name, limit: "25", offset: "0", include_price_history: "false", include_statistics: "30d" });

  debug.justtcg.cardAttempts = [];

  for (const params of attempts) {
    const url = `${JUSTTCG_BASE}/cards?` + new URLSearchParams(params).toString();

    const r = await fetchWithTimeout(url, {
      method: "GET",
      headers: { "x-api-key": apiKey, Accept: "application/json" },
    });

    const j = await r.json().catch(() => ({}));
    const list = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];

    const dbg = {
      url,
      http: r.status,
      count: list.length,
      error: r.ok ? null : (j?.message || j?.error || `HTTP ${r.status}`),
    };
    debug.justtcg.cardAttempts.push(dbg);

    if (!r.ok || !list.length) continue;

    // pick best by name contains + set match if present + number match if present
    const wantedName = name.toLowerCase();
    const wantedSetName = (setName || "").toLowerCase();
    const wantedNumber = (number || "").toLowerCase();

    const score = (it) => {
      let s = 0;
      const nm = String(it?.name || "").toLowerCase();
      const st = String(it?.set_name || it?.setName || it?.set || "").toLowerCase();
      const no = String(it?.number || "").toLowerCase();
      if (nm === wantedName) s += 8;
      else if (nm.includes(wantedName)) s += 5;
      if (wantedSetName && st.includes(wantedSetName)) s += 3;
      if (wantedNumber && no === wantedNumber) s += 6;
      if (Array.isArray(it?.variants) && it.variants.length) s += 1;
      return s;
    };

    const ranked = [...list].sort((a, b) => score(b) - score(a));
    const picked = ranked[0];

    debug.justtcg.pickedCard = {
      id: picked?.id || null,
      name: picked?.name || null,
      set_name: picked?.set_name || picked?.setName || null,
      number: picked?.number || null,
    };

    const priceUSD = pickVariantPrice(picked, wantPrinting, debug);
    if (!isFinite(priceUSD)) continue;

    return {
      ok: true,
      value: {
        source: "JustTCG",
        currency: "USD", // per docs, card variant price is in USD
        raw: priceUSD,
        picked: debug.justtcg.pickedCard,
      },
    };
  }

  return { ok: false, reason: "No results" };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  const debug = { justtcg: {}, fx: {} };

  try {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const { card, distribution, feeGBP } = await readBody(req);
    if (!card?.game || !card?.name) return json(res, 400, { error: "Missing card (game + name required)" });

    const live = await justTCGPriceUSD(card, debug);

    if (!live.ok) {
      return json(res, 200, {
        source: null,
        raw: null,
        currency: null,
        note: "Live pricing unavailable. Use manual raw override.",
        debug,
      });
    }

    // EV graded using distribution + uplift on RAW
    const dist =
      Array.isArray(distribution) && distribution.length
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
      evGraded += prob * (live.value.raw * upliftMultiplier(grade));
    }

    // FX (ECB EUR base)
    const fx = await getFX(debug);
    const fee = isFinite(Number(feeGBP)) ? Number(feeGBP) : 15;

    const out = {
      source: live.value.source,
      raw: live.value.raw,
      currency: live.value.currency, // USD
      evGraded,
      upliftModel: "conservative",
      picked: live.value.picked,
      fx: { base: fx.base, GBP: fx.GBP, USD: fx.USD },
      converted: {},
      debug,
    };

    // Convert USD raw/EV to GBP/EUR/USD for your UI
    for (const ccy of ["GBP", "EUR", "USD"]) {
      const rawC = convert(live.value.raw, "USD", ccy, fx);
      const evC = convert(evGraded, "USD", ccy, fx);
      const feeC = convert(fee, "GBP", ccy, fx);
      out.converted[ccy] = { raw: rawC, evGraded: evC, fee: feeC };
    }

    return json(res, 200, out);
  } catch (e) {
    debug.error = e?.message || "Pricing failed";
    return json(res, 500, { error: debug.error, debug });
  }
}