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

function normalizeCollectorNumber(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
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

function desiredPrintingFromVariant(variant) {
  const v = String(variant || "").toLowerCase();
  if (!v) return "Normal";
  if (v.includes("reverse")) return "Reverse Holofoil";
  if (v.includes("holo") || v.includes("foil") || v.includes("etched")) return "Holofoil";
  if (v.includes("1st")) return "1st Edition";
  return "Normal";
}

function desiredCondition() {
  return "Near Mint";
}

// Sealed / non-single filters (stop booster packs etc.)
function looksLikeSealedOrNonSingle(item) {
  const name = String(item?.name || "").toLowerCase();
  const id = String(item?.id || item?.cardId || "").toLowerCase();

  const bad = [
    "booster pack",
    "booster box",
    "display box",
    "box",
    "case",
    "pack",
    "tin",
    "bundle",
    "elite trainer box",
    "etb",
    "starter deck",
    "structure deck",
    "theme deck",
    "precon",
    "collection",
    "blister",
    "lot",
    "bulk",
    "sealed",
    "promo pack",
  ];

  // If it literally says "booster pack", it's not a single.
  if (bad.some((k) => name.includes(k))) return true;
  if (bad.some((k) => id.includes(k.replace(/\s+/g, "-")))) return true;

  return false;
}

function pickBestVariantPrice(cardItem, wantPrinting, wantCondition) {
  const variants = Array.isArray(cardItem?.variants) ? cardItem.variants : [];
  if (!variants.length) return null;

  const wantP = String(wantPrinting || "").toLowerCase();
  const wantC = String(wantCondition || "").toLowerCase();

  const prices = (list) =>
    list
      .map((v) => Number(v?.price))
      .filter((p) => isFinite(p));

  const exact = variants.filter(
    (v) =>
      String(v?.printing || "").toLowerCase() === wantP &&
      String(v?.condition || "").toLowerCase() === wantC
  );
  const exactPrices = prices(exact);
  if (exactPrices.length) return Math.min(...exactPrices);

  const nm = variants.filter((v) => String(v?.condition || "").toLowerCase() === wantC);
  const nmPrices = prices(nm);
  if (nmPrices.length) return Math.min(...nmPrices);

  const anyPrices = prices(variants);
  if (anyPrices.length) return Math.min(...anyPrices);

  return null;
}

async function justTCGSetLookup(gameId, setName, apiKey, debug) {
  if (!setName) return null;

  const url =
    "https://api.justtcg.com/v1/sets?" +
    new URLSearchParams({
      game: gameId,
      q: setName,
      limit: "20",
      offset: "0",
    }).toString();

  debug.justtcg.setLookup = { url, http: null, count: 0, error: null, picked: null };

  try {
    const r = await fetchWithTimeout(
      url,
      { headers: { "X-API-Key": apiKey, Accept: "application/json" } },
      9000
    );
    debug.justtcg.setLookup.http = r.status;

    const j = await r.json().catch(() => ({}));
    const list = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : [];
    debug.justtcg.setLookup.count = list.length;

    if (!r.ok) {
      debug.justtcg.setLookup.error = j?.error?.message || j?.message || j?.error || `HTTP ${r.status}`;
      return null;
    }
    if (!list.length) return null;

    const want = String(setName).toLowerCase();
    const score = (s) => {
      const nm = String(s?.name || s?.set_name || "").toLowerCase();
      if (!nm) return 0;
      if (nm === want) return 10;
      if (nm.includes(want)) return 6;
      return 1;
    };
    const ranked = [...list].sort((a, b) => score(b) - score(a));
    const picked = ranked[0];

    const setId = picked?.id || picked?.setId || picked?.slug || null;
    debug.justtcg.setLookup.picked = { id: setId, name: picked?.name || picked?.set_name || null };

    return setId || null;
  } catch (e) {
    debug.justtcg.setLookup.http = "FETCH_ERR";
    debug.justtcg.setLookup.error = e?.message || "fetch error";
    return null;
  }
}

function getItemNumber(it) {
  const n =
    it?.number ??
    it?.collectorNumber ??
    it?.localId ??
    it?.cardNumber ??
    null;
  if (n == null) return null;
  const s = String(n).trim();
  if (!s || s.toLowerCase() === "n/a") return null;
  return s;
}

function scoreCandidate(it, wantName, wantSet, wantNum) {
  // Higher = better
  let s = 0;

  const nm = String(it?.name || "").toLowerCase();
  const st = String(it?.set_name || it?.set || it?.setName || "").toLowerCase();
  const num = getItemNumber(it);

  // sealed penalty (hard filtered earlier, but keep defensive)
  if (looksLikeSealedOrNonSingle(it)) s -= 1000;

  // number match matters most when user supplied number
  if (wantNum && num && String(num) === String(wantNum)) s += 200;
  else if (wantNum && num && String(num).includes(String(wantNum))) s += 80;
  else if (wantNum && !num) s -= 40;

  // name match
  if (wantName) {
    if (nm === wantName) s += 120;
    else if (nm.includes(wantName)) s += 70;
    else s -= 30;
  }

  // set match
  if (wantSet) {
    if (st === wantSet) s += 60;
    else if (st.includes(wantSet)) s += 25;
  }

  // prefer items with variants
  if (Array.isArray(it?.variants) && it.variants.length) s += 10;

  return s;
}

async function justTCGCardsSearch(card, debug) {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return { ok: false, reason: "Missing JUSTTCG_API_KEY" };

  const gameId = toJustTCGGameId(card?.game);
  if (!gameId) return { ok: false, reason: "Unsupported game" };

  debug.justtcg = debug.justtcg || {};
  debug.justtcg.gameId = gameId;
  debug.justtcg.cardAttempts = [];

  const wantCondition = desiredCondition();
  const wantPrinting = desiredPrintingFromVariant(card?.variant);

  const wantName = String(card?.name || "").trim().toLowerCase() || null;
  const wantSet = String(card?.set || "").trim().toLowerCase() || null;
  const wantNum = normalizeCollectorNumber(card?.collectorNumber);

  const setId = await justTCGSetLookup(gameId, card?.set, apiKey, debug);
  const base = "https://api.justtcg.com/v1/cards";

  const attempts = [
    setId && wantNum
      ? {
          label: "set+number",
          params: {
            game: gameId,
            set: setId,
            number: String(wantNum),
            limit: "20",
            offset: "0",
            include_price_history: "false",
            include_statistics: "30d",
          },
        }
      : null,
    setId && card?.name
      ? {
          label: "set+q(name)",
          params: {
            game: gameId,
            set: setId,
            q: String(card.name).trim(),
            limit: "20",
            offset: "0",
            include_price_history: "false",
            include_statistics: "30d",
          },
        }
      : null,
    card?.name
      ? {
          label: "q(name+set+num)",
          params: {
            game: gameId,
            q: [card.name, card.set, wantNum].filter(Boolean).join(" "),
            limit: "20",
            offset: "0",
            include_price_history: "false",
            include_statistics: "30d",
          },
        }
      : null,
    card?.name
      ? {
          label: "q(name)",
          params: {
            game: gameId,
            q: String(card.name).trim(),
            limit: "20",
            offset: "0",
            include_price_history: "false",
            include_statistics: "30d",
          },
        }
      : null,
  ].filter(Boolean);

  for (const a of attempts) {
    const url = base + "?" + new URLSearchParams(a.params).toString();

    try {
      const r = await fetchWithTimeout(url, { headers: { "X-API-Key": apiKey, Accept: "application/json" } }, 9000);
      const j = await r.json().catch(() => ({}));

      const list = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : [];
      debug.justtcg.cardAttempts.push({
        label: a.label,
        url,
        http: r.status,
        count: list.length,
        error: !r.ok ? (j?.error?.message || j?.message || j?.error || `HTTP ${r.status}`) : null,
      });

      if (!r.ok) continue;
      if (!list.length) continue;

      // 1) drop sealed/non-single items
      let filtered = list.filter((it) => !looksLikeSealedOrNonSingle(it));

      // 2) if we have a number, require exact number match if possible
      if (wantNum) {
        const exactNum = filtered.filter((it) => String(getItemNumber(it) || "") === String(wantNum));
        if (exactNum.length) filtered = exactNum;
      }

      // 3) if we have a name, require it to appear in the item name if possible
      if (wantName) {
        const nameMatch = filtered.filter((it) => String(it?.name || "").toLowerCase().includes(wantName));
        if (nameMatch.length) filtered = nameMatch;
      }

      if (!filtered.length) continue;

      // Rank remaining candidates
      const ranked = [...filtered].sort(
        (x, y) => scoreCandidate(y, wantName, wantSet, wantNum) - scoreCandidate(x, wantName, wantSet, wantNum)
      );
      const picked = ranked[0];

      const raw = pickBestVariantPrice(picked, wantPrinting, wantCondition);
      if (!isFinite(raw)) continue;

      // If API doesn’t provide currency, assume USD (common) — but allow override if present
      const currency = String(picked?.currency || j?.currency || "USD").toUpperCase();

      return {
        ok: true,
        value: {
          source: "JustTCG",
          currency,
          raw,
          picked: {
            id: picked?.id || picked?.cardId || null,
            name: picked?.name || null,
            set: picked?.set_name || picked?.set || picked?.setName || null,
            number: getItemNumber(picked),
            want: { printing: wantPrinting, condition: wantCondition },
          },
        },
      };
    } catch (e) {
      debug.justtcg.cardAttempts.push({
        label: a.label,
        url: null,
        http: "FETCH_ERR",
        count: 0,
        error: e?.message || "fetch error",
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
    if (!card?.game || !card?.name) return json(res, 400, { error: "Missing card (game + name required)" });

    const live = await justTCGCardsSearch(card, debug);

    if (!live.ok) {
      return json(res, 200, {
        source: null,
        raw: null,
        currency: null,
        note: "Live pricing unavailable. Use manual raw override.",
        debug,
      });
    }

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