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

    // Small XML parse via regex: <Cube currency='USD' rate='1.0'/>
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
function toJustTCGGameId(game) {
  const g = String(game || "").toLowerCase();
  if (g === "pokemon") return "pokemon";
  if (g === "mtg" || g.includes("magic")) return "magic-the-gathering";
  if (g === "yugioh" || g.includes("yu")) return "yu-gi-oh";
  return null;
}

function normalizePrintingWanted(variant) {
  const v = String(variant || "").toLowerCase();
  // Your UI/identify tends to say "holo/reverse/foil/etched"
  if (v.includes("foil") || v.includes("holo") || v.includes("reverse") || v.includes("etched")) return "Foil";
  return "Normal";
}

function buildNameQuery(card) {
  return String(card?.name || "").trim();
}

function buildSetQuery(card) {
  // Prefer explicit set name; fall back to setCode if user passed it.
  return String(card?.set || card?.setCode || "").trim();
}

function normalizeCollectorNumber(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // "11/108" -> "11"
  if (s.includes("/")) return s.split("/")[0].trim();
  return s;
}

// Strict variant picker so we stop choosing the wrong (expensive) variant.
// IMPORTANT: JustTCG docs say variant.price is USD.
function pickVariantPrice(item, wanted = { condition: "Near Mint", printing: "Normal", language: "English" }) {
  const variants = Array.isArray(item?.variants) ? item.variants : [];
  if (!variants.length) return null;

  const norm = (s) => String(s || "").trim().toLowerCase();
  const wantC = norm(wanted.condition);
  const wantP = norm(wanted.printing);
  const wantL = norm(wanted.language);

  const score = (v) => {
    let s = 0;

    const c = norm(v?.condition);
    const p = norm(v?.printing);
    const l = norm(v?.language);

    // exact matches
    if (c === wantC) s += 10;
    if (p === wantP) s += 8;
    if (l === wantL) s += 6;

    // fuzzy fallbacks
    if (c.includes("near") && c.includes("mint")) s += 2;
    if (p.includes("normal")) s += 1;
    if (l.includes("english")) s += 1;

    // de-prioritise obvious mismatches
    if (wantP === "normal" && (p.includes("foil") || p.includes("holo") || p.includes("reverse"))) s -= 3;
    if (wantL === "english" && (l.includes("japanese") || l.includes("korean") || l.includes("german"))) s -= 2;

    return s;
  };

  const ranked = variants
    .map((v) => ({ v, p: Number(v?.price) }))
    .filter((x) => Number.isFinite(x.p))
    .sort((a, b) => score(b.v) - score(a.v));

  if (!ranked.length) return null;

  return {
    priceUSD: ranked[0].p,
    pickedVariant: ranked[0].v,
  };
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

async function readJsonSafe(r) {
  return await r.json().catch(() => ({}));
}

// Look up a set slug/id from JustTCG (so we can query cards by set+number)
async function justTCGFindSetSlug({ gameId, setName }, debug) {
  if (!setName) return null;

  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return null;

  const url =
    "https://api.justtcg.com/v1/sets?" +
    new URLSearchParams({
      game: gameId,
      q: setName,
      limit: "20", // plan limit: 1..20
      offset: "0",
    }).toString();

  debug.justtcg = debug.justtcg || {};
  debug.justtcg.setLookup = { url, http: null, count: 0, error: null };

  const r = await fetchWithTimeout(
    url,
    { headers: { "x-api-key": apiKey, Accept: "application/json" } },
    9000
  );
  const j = await readJsonSafe(r);

  const list = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : [];
  debug.justtcg.setLookup.http = r.status;
  debug.justtcg.setLookup.count = list.length;
  debug.justtcg.setLookup.error = r.ok ? null : (j?.error || j?.message || `HTTP ${r.status}`);

  if (!r.ok || !list.length) return null;

  // Try to pick best by contains
  const wanted = String(setName).toLowerCase();
  const score = (s) => {
    const nm = String(s?.name || s?.set || "").toLowerCase();
    if (!nm) return 0;
    if (nm === wanted) return 10;
    if (nm.includes(wanted)) return 6;
    return 1;
  };
  const ranked = [...list].sort((a, b) => score(b) - score(a));
  const picked = ranked[0];

  // Common fields might be: id, slug
  return picked?.slug || picked?.id || picked?.code || null;
}

// Search cards with a fast-first pipeline:
// 1) set + number (best precision)
// 2) set + q (name only)
// 3) q only (name + set words)
async function justTCGSearchCard(card, debug) {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return { ok: false, reason: "Missing JUSTTCG_API_KEY" };

  const gameId = toJustTCGGameId(card?.game);
  if (!gameId) return { ok: false, reason: "Unsupported game" };

  const name = buildNameQuery(card);
  if (!name) return { ok: false, reason: "Missing card name" };

  const setName = buildSetQuery(card);
  const number = normalizeCollectorNumber(card?.collectorNumber);

  debug.justtcg = debug.justtcg || {};
  debug.justtcg.gameId = gameId;
  debug.justtcg.cardAttempts = [];

  // Try to resolve set slug/id once (if set name exists)
  let setSlug = null;
  if (setName) {
    setSlug = await justTCGFindSetSlug({ gameId, setName }, debug);
  }

  const base = "https://api.justtcg.com/v1/cards";
  const limit = "20"; // IMPORTANT: plan says 1..20

  const attempts = [];

  if (setSlug && number) {
    attempts.push({
      label: "set+number",
      params: {
        game: gameId,
        set: setSlug,
        number: String(number),
        limit,
        offset: "0",
        include_price_history: "false",
        include_statistics: "30d",
      },
    });
  }

  if (setSlug) {
    attempts.push({
      label: "set+q(name)",
      params: {
        game: gameId,
        set: setSlug,
        q: name,
        limit,
        offset: "0",
        include_price_history: "false",
        include_statistics: "30d",
      },
    });
  }

  // last resort: q includes set words
  const qLoose = setName ? `${name} ${setName}` : name;
  attempts.push({
    label: "q(loose)",
    params: {
      game: gameId,
      q: qLoose,
      limit,
      offset: "0",
      include_price_history: "false",
      include_statistics: "30d",
    },
  });

  const wantedName = name.toLowerCase();
  const wantedSet = String(setName || "").toLowerCase();
  const wantedPrinting = normalizePrintingWanted(card?.variant); // "Normal" or "Foil"

  const scoreItem = (it) => {
    let s = 0;
    const nm = String(it?.name || "").toLowerCase();
    const st = String(it?.set?.name || it?.set_name || it?.set || it?.setName || "").toLowerCase();
    const num = String(it?.number || it?.collectorNumber || it?.localId || "").trim();

    if (nm === wantedName) s += 10;
    else if (nm.includes(wantedName)) s += 6;

    if (wantedSet && st.includes(wantedSet)) s += 4;

    if (number && num && num === String(number)) s += 8;

    if (Array.isArray(it?.variants) && it.variants.length) s += 2;

    // mild nudge: if variants exist, prefer those that likely include wanted printing
    if (Array.isArray(it?.variants)) {
      const hasWantedPrinting = it.variants.some(v => String(v?.printing || "").toLowerCase() === wantedPrinting.toLowerCase());
      if (hasWantedPrinting) s += 1;
    }

    return s;
  };

  for (const a of attempts) {
    const url = base + "?" + new URLSearchParams(a.params).toString();

    try {
      const r = await fetchWithTimeout(url, {
        headers: { "x-api-key": apiKey, Accept: "application/json" },
      }, 9000);
      const j = await readJsonSafe(r);

      const list = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : [];
      debug.justtcg.cardAttempts.push({
        label: a.label,
        url,
        http: r.status,
        count: list.length,
        error: r.ok ? null : (j?.error || j?.message || `HTTP ${r.status}`),
      });

      if (!r.ok || !list.length) continue;

      const ranked = [...list].sort((x, y) => scoreItem(y) - scoreItem(x));
      const picked = ranked[0];

      // Strictly pick the desired variant; avoid grabbing max price.
      const pv = pickVariantPrice(picked, {
        condition: "Near Mint",
        printing: wantedPrinting, // Normal vs Foil inferred from variant
        language: "English",
      });

      if (!pv || !isFinite(pv.priceUSD)) continue;

      // Per JustTCG docs: variants.price is USD
      const currency = "USD";
      const raw = pv.priceUSD;

      return {
        ok: true,
        value: {
          source: "JustTCG",
          currency,
          raw,
          picked: {
            id: picked?.id || picked?.cardId || null,
            name: picked?.name || null,
            set: picked?.set?.name || picked?.set_name || picked?.set || picked?.setName || null,
            number: picked?.number || picked?.collectorNumber || null,
            variantPicked: {
              condition: pv.pickedVariant?.condition || null,
              printing: pv.pickedVariant?.printing || null,
              language: pv.pickedVariant?.language || null,
              price: pv.pickedVariant?.price ?? null,
            },
          },
        },
      };
    } catch (e) {
      debug.justtcg.cardAttempts.push({
        label: a.label,
        url,
        http: "FETCH_ERR",
        count: 0,
        error: String(e?.message || e),
      });
      continue;
    }
  }

  return { ok: false, reason: "No results" };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  const debug = { justtcg: { cardAttempts: [] }, fx: {} };

  try {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const { card, distribution, feeGBP } = await readBody(req);
    if (!card?.game || !card?.name) {
      return json(res, 400, { error: "Missing card (game + name required)" });
    }

    const live = await justTCGSearchCard(card, debug);

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
      currency: live.value.currency, // USD (per JustTCG)
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