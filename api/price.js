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

// ---------- FX (ECB) ----------
// ECB publishes EUR base rates in XML.
async function getFX(debug) {
  const url = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
  debug.fx = debug.fx || {};
  debug.fx.url = url;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);

  try {
    const r = await fetch(url, { signal: ctrl.signal });
    debug.fx.http = r.status;
    if (!r.ok) throw new Error(`ECB FX HTTP ${r.status}`);

    const xml = await r.text();

    // Very small XML parse via regex: <Cube currency='USD' rate='1.0'/>
    const pick = (ccy) => {
      const re = new RegExp(`currency=['"]${ccy}['"]\\s+rate=['"]([0-9.]+)['"]`, "i");
      const m = xml.match(re);
      return m ? Number(m[1]) : null;
    };

    const USD = pick("USD");
    const GBP = pick("GBP");

    if (!USD || !GBP) throw new Error("ECB FX parse failed");

    return { base: "EUR", USD, GBP };
  } finally {
    clearTimeout(t);
  }
}

// Convert between currencies using ECB rates (EUR base).
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

// ---------- JustTCG helpers ----------
function toJustTCGGame(game) {
  const g = String(game || "").toLowerCase();
  if (g === "pokemon") return "Pokemon";
  if (g === "mtg" || g.includes("magic")) return "Magic: The Gathering";
  if (g === "yugioh" || g.includes("yu")) return "Yu-Gi-Oh!";
  return null;
}

function normalizePrinting(variant) {
  const v = String(variant || "").toLowerCase();
  if (v.includes("foil") || v.includes("holo") || v.includes("reverse") || v.includes("etched")) return "foil";
  return "normal";
}

function buildQuery(card) {
  const parts = [];
  if (card?.name) parts.push(String(card.name).trim());
  if (card?.set) parts.push(String(card.set).trim());
  // collector number helps if their search supports it; otherwise it’s harmless.
  if (card?.collectorNumber) parts.push(String(card.collectorNumber).trim());
  return parts.filter(Boolean).join(" ").trim();
}

function pickPriceFromCardItem(item) {
  // Common shapes:
  // - item.price
  // - item.marketPrice
  // - item.variants: [{ price, marketPrice, printing, condition }]
  const direct =
    Number(item?.marketPrice ?? item?.price ?? item?.avg ?? item?.mid ?? item?.low ?? item?.eur ?? item?.gbp ?? item?.usd);
  if (isFinite(direct)) return direct;

  const variants = Array.isArray(item?.variants) ? item.variants : [];
  if (!variants.length) return null;

  // pick max price variant (often best approximation if “market” is per-variant)
  let best = null;
  for (const v of variants) {
    const p = Number(v?.marketPrice ?? v?.price ?? v?.avg ?? v?.mid ?? v?.low);
    if (!isFinite(p)) continue;
    if (!best || p > best) best = p;
  }
  return best;
}

async function justTCGSearch(card, debug) {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return { ok: false, reason: "Missing JUSTTCG_API_KEY" };

  const game = toJustTCGGame(card?.game);
  const q = buildQuery(card);
  if (!game || !q) return { ok: false, reason: "Missing game/name for query" };

  const printing = normalizePrinting(card?.variant);
  // For /v1/cards discovery, many APIs want slugs. We try “near-mint”.
  const condition = "near-mint";

  const base = "https://api.justtcg.com/v1/cards";

  const attempts = [
    // best guess: with condition & printing
    { params: { q, game, condition, printing, limit: "25", offset: "0", include_price_history: "false", include_statistics: "30d" } },
    // fallback: remove condition/printing (some plans/endpoints reject them)
    { params: { q, game, limit: "25", offset: "0" } },
    // fallback: remove set/number by using only name
    { params: { q: String(card?.name || "").trim(), game, limit: "25", offset: "0" } },
  ];

  debug.justtcg = debug.justtcg || { attempts: [] };

  for (const a of attempts) {
    const url = base + "?" + new URLSearchParams(a.params).toString();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);

    try {
      const r = await fetch(url, {
        method: "GET",
        headers: { "x-api-key": apiKey, Accept: "application/json" },
        signal: ctrl.signal,
      });

      const j = await r.json().catch(() => ({}));

      const list = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : [];
      debug.justtcg.attempts.push({
        url,
        http: r.status,
        count: list.length,
        error: !r.ok ? (j?.error || j?.message || `HTTP ${r.status}`) : null,
      });

      if (!r.ok) continue;
      if (!list.length) continue;

      // pick the best match by basic scoring (name + set contains)
      const wantedName = String(card?.name || "").toLowerCase();
      const wantedSet = String(card?.set || "").toLowerCase();

      const score = (it) => {
        let s = 0;
        const nm = String(it?.name || "").toLowerCase();
        const st = String(it?.set || it?.setName || "").toLowerCase();
        if (wantedName && nm.includes(wantedName)) s += 5;
        if (wantedSet && st.includes(wantedSet)) s += 2;
        // prefer having variants
        if (Array.isArray(it?.variants) && it.variants.length) s += 1;
        return s;
      };

      const ranked = [...list].sort((x, y) => score(y) - score(x));
      const picked = ranked[0];

      const raw = pickPriceFromCardItem(picked);
      if (!isFinite(raw)) continue;

      // JustTCG appears largely EUR/TCGPlayer based; if response gives currency, use it.
      const currency = (picked?.currency || j?.currency || "EUR").toUpperCase();

      return {
        ok: true,
        value: {
          source: "JustTCG",
          currency,
          raw,
          picked: {
            name: picked?.name || null,
            set: picked?.set || picked?.setName || null,
            id: picked?.id || picked?.cardId || null,
          },
        },
      };
    } catch (e) {
      debug.justtcg.attempts.push({ url: null, http: "FETCH_ERR", count: 0, error: e?.message || "fetch error" });
      continue;
    } finally {
      clearTimeout(t);
    }
  }

  return { ok: false, reason: "No results" };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  const debug = { justtcg: { attempts: [] }, fx: {} };

  try {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const { card, distribution, feeGBP } = await readBody(req);
    if (!card?.game || !card?.name) return json(res, 400, { error: "Missing card (game + name required)" });

    const live = await justTCGSearch(card, debug);

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
      currency: live.value.currency,
      evGraded,
      upliftModel: "conservative",
      picked: live.value.picked,
      fx: { base: fx.base, GBP: fx.GBP, USD: fx.USD },
      converted: {},
      debug,
    };

    for (const ccy of ["GBP", "EUR", "USD"]) {
      const rawC = convert(live.value.raw, live.value.currency, ccy, fx);
      const evC = convert(evGraded, live.value.currency, ccy, fx);
      const feeC = convert(fee, "GBP", ccy, fx);
      out.converted[ccy] = { raw: rawC, evGraded: evC, fee: feeC };
    }

    return json(res, 200, out);
  } catch (e) {
    debug.error = e?.message || "Pricing failed";
    return json(res, 500, { error: debug.error, debug });
  }
}