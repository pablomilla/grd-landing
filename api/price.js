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

async function fetchWithTimeout(url, opts = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function safeLower(x) {
  return String(x || "").trim().toLowerCase();
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

// Convert between currencies using ECB rates (EUR base).
function convert(amount, from, to, rates) {
  if (amount == null || !isFinite(amount)) return null;
  from = (from || "EUR").toUpperCase();
  to = (to || "EUR").toUpperCase();
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

// ---------- ROI uplift model (placeholder) ----------
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

// IMPORTANT: your plan limit (from your error): 1..20
const PLAN_LIMIT = 20;

function toJustTCGGameId(game) {
  const g = safeLower(game);
  if (g === "pokemon") return "pokemon";
  if (g === "mtg" || g.includes("magic")) return "mtg";
  if (g === "yugioh" || g.includes("yu")) return "yugioh";
  return null;
}

function normalizePrinting(variant) {
  const v = safeLower(variant);
  if (v.includes("foil") || v.includes("holo") || v.includes("reverse") || v.includes("etched")) return "Foil";
  return "Normal";
}

function pickPrice(item) {
  // Try common fields first
  const direct = Number(
    item?.marketPrice ??
      item?.price ??
      item?.avg ??
      item?.mid ??
      item?.low ??
      item?.statistics?.market ??
      item?.statistics?.avg
  );
  if (isFinite(direct)) return direct;

  const variants = Array.isArray(item?.variants) ? item.variants : [];
  let best = null;
  for (const v of variants) {
    const p = Number(v?.marketPrice ?? v?.price ?? v?.avg ?? v?.mid ?? v?.low);
    if (!isFinite(p)) continue;
    if (best == null || p > best) best = p;
  }
  return best;
}

function scoreCardResult(wanted, it) {
  const wName = safeLower(wanted?.name);
  const wSet = safeLower(wanted?.set);
  const wNum = String(wanted?.collectorNumber || wanted?.number || "").trim();

  const n = safeLower(it?.name);
  const s = safeLower(it?.set?.name || it?.setName || it?.set || "");
  const num = String(it?.number || it?.collectorNumber || it?.localId || "").trim();

  let score = 0;
  if (wName && n.includes(wName)) score += 6;
  if (wSet && s.includes(wSet)) score += 3;
  if (wNum && num === wNum) score += 5;
  if (Array.isArray(it?.variants) && it.variants.length) score += 1;

  return score;
}

async function justtcgGet(url, apiKey) {
  return await fetchWithTimeout(url, { headers: { "x-api-key": apiKey, Accept: "application/json" } }, 9000);
}

async function lookupSetSlug({ gameId, setName }, apiKey, debug) {
  if (!setName) return null;

  const params = new URLSearchParams({
    game: gameId,
    q: setName,
    limit: String(PLAN_LIMIT),
    offset: "0",
  });

  const url = `${JUSTTCG_BASE}/sets?${params.toString()}`;
  debug.justtcg.setLookup = { url, http: null, count: 0, error: null };

  const r = await justtcgGet(url, apiKey);
  const j = await r.json().catch(() => ({}));

  const list = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
  debug.justtcg.setLookup.http = r.status;
  debug.justtcg.setLookup.count = list.length;
  debug.justtcg.setLookup.error = r.ok ? null : (j?.error || j?.message || `HTTP ${r.status}`);

  if (!r.ok || !list.length) return null;

  // Best guess match by name inclusion
  const wanted = safeLower(setName);
  const ranked = [...list].sort((a, b) => {
    const an = safeLower(a?.name);
    const bn = safeLower(b?.name);
    const as = an.includes(wanted) ? 1 : 0;
    const bs = bn.includes(wanted) ? 1 : 0;
    return bs - as;
  });

  // Common slug fields: slug / id
  return ranked[0]?.slug || ranked[0]?.id || null;
}

async function justtcgCardSearch(card, apiKey, debug) {
  const gameId = toJustTCGGameId(card?.game);
  if (!gameId) return { ok: false, reason: "Unsupported game" };

  const name = String(card?.name || "").trim();
  if (!name) return { ok: false, reason: "Missing card name" };

  const setName = String(card?.set || "").trim() || null;
  const number = String(card?.collectorNumber || "").trim() || null;
  const printing = normalizePrinting(card?.variant);

  debug.justtcg = debug.justtcg || {};
  debug.justtcg.gameId = gameId;
  debug.justtcg.cardAttempts = [];

  const setSlug = await lookupSetSlug({ gameId, setName }, apiKey, debug);

  const attempts = [];

  // Best: set + number (exact)
  if (setSlug && number) {
    attempts.push({
      params: {
        game: gameId,
        set: setSlug,
        number,
        limit: String(PLAN_LIMIT),
        offset: "0",
        include_price_history: "false",
        include_statistics: "30d",
      },
    });
  }

  // Next: set + q=name
  if (setSlug) {
    attempts.push({
      params: {
        game: gameId,
        set: setSlug,
        q: name,
        limit: String(PLAN_LIMIT),
        offset: "0",
        include_price_history: "false",
        include_statistics: "30d",
      },
    });
  }

  // Next: q=name + setName words
  if (setName) {
    attempts.push({
      params: {
        game: gameId,
        q: `${name} ${setName}`.trim(),
        limit: String(PLAN_LIMIT),
        offset: "0",
        include_price_history: "false",
        include_statistics: "30d",
      },
    });
  }

  // Last: q=name only
  attempts.push({
    params: {
      game: gameId,
      q: name,
      limit: String(PLAN_LIMIT),
      offset: "0",
      include_price_history: "false",
      include_statistics: "30d",
    },
  });

  for (const a of attempts) {
    // IMPORTANT: some plans reject unknown params; if you get 400, you can prune later.
    const url = `${JUSTTCG_BASE}/cards?${new URLSearchParams(a.params).toString()}`;

    const r = await justtcgGet(url, apiKey);
    const j = await r.json().catch(() => ({}));

    const list = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : [];
    const dbg = {
      url,
      http: r.status,
      count: list.length,
      error: r.ok ? null : (j?.error || j?.message || `HTTP ${r.status}`),
      picked: null,
    };
    debug.justtcg.cardAttempts.push(dbg);

    if (!r.ok || !list.length) continue;

    // Rank and pick best
    const ranked = [...list].sort((x, y) => scoreCardResult(card, y) - scoreCardResult(card, x));
    const picked = ranked[0];

    const raw = pickPrice(picked);
    if (!isFinite(raw)) continue;

    const currency = String(picked?.currency || j?.currency || "EUR").toUpperCase();

    dbg.picked = {
      id: picked?.id || picked?.cardId || null,
      name: picked?.name || null,
      set: picked?.set?.name || picked?.setName || picked?.set || null,
      number: picked?.number || null,
      printing,
      currency,
      raw,
    };

    return {
      ok: true,
      value: {
        source: "JustTCG",
        currency,
        raw,
        picked: dbg.picked,
      },
    };
  }

  return { ok: false, reason: "No results" };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  const debug = { justtcg: { cardAttempts: [] }, fx: {} };

  try {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const apiKey = process.env.JUSTTCG_API_KEY;
    if (!apiKey) return json(res, 500, { error: "Missing JUSTTCG_API_KEY" });

    const { card, distribution, feeGBP } = await readBody(req);
    if (!card?.game || !card?.name) return json(res, 400, { error: "Missing card (game + name required)" });

    const live = await justtcgCardSearch(card, apiKey, debug);

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

    const fee = isFinite(Number(feeGBP)) ? Number(feeGBP) : 15;

    // FX: don’t block response if ECB fails
    let fx = null;
    try {
      fx = await getFX(debug);
    } catch (e) {
      debug.fx.error = String(e?.message || e);
      fx = null;
    }

    const out = {
      source: live.value.source,
      raw: live.value.raw,
      currency: live.value.currency,
      evGraded,
      upliftModel: "conservative",
      picked: live.value.picked,
      fx: fx ? { base: fx.base, GBP: fx.GBP, USD: fx.USD } : null,
      converted: {},
      debug,
    };

    if (fx) {
      for (const ccy of ["GBP", "EUR", "USD"]) {
        const rawC = convert(live.value.raw, live.value.currency, ccy, fx);
        const evC = convert(evGraded, live.value.currency, ccy, fx);
        const feeC = convert(fee, "GBP", ccy, fx);
        out.converted[ccy] = { raw: rawC, evGraded: evC, fee: feeC };
      }
    }

    return json(res, 200, out);
  } catch (e) {
    debug.error = e?.message || "Pricing failed";
    return json(res, 500, { error: debug.error, debug });
  }
}