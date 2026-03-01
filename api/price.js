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
  // "11/108" -> "11"
  if (s.includes("/")) return s.split("/")[0].trim();
  return s;
}

function desiredPrintingFromVariant(variant) {
  const v = String(variant || "").toLowerCase();

  // Keep this conservative: default "Normal"
  // If later you want higher accuracy, map Pokémon "Holofoil/Reverse Holofoil" etc.
  if (!v) return "Normal";

  if (v.includes("reverse")) return "Reverse Holofoil";
  if (v.includes("holo") || v.includes("foil") || v.includes("etched")) return "Holofoil";
  if (v.includes("1st")) return "1st Edition";

  return "Normal";
}

function desiredCondition() {
  // Use the same label JustTCG shows in variants and examples
  return "Near Mint";
}

function buildLooseQuery(card) {
  const parts = [];
  if (card?.name) parts.push(String(card.name).trim());
  if (card?.set) parts.push(String(card.set).trim());
  if (card?.collectorNumber) parts.push(String(card.collectorNumber).trim());
  return parts.filter(Boolean).join(" ").trim();
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

function pickBestVariantPrice(cardItem, wantPrinting, wantCondition) {
  const variants = Array.isArray(cardItem?.variants) ? cardItem.variants : [];
  if (!variants.length) return null;

  // Prefer exact matches, otherwise fall back safely.
  const exact = variants.filter(
    (v) =>
      String(v?.printing || "").toLowerCase() === String(wantPrinting || "").toLowerCase() &&
      String(v?.condition || "").toLowerCase() === String(wantCondition || "").toLowerCase() &&
      isFinite(Number(v?.price))
  );

  if (exact.length) {
    // If multiple (rare), take the LOWEST price (conservative, avoids £350 spikes)
    return Math.min(...exact.map((v) => Number(v.price)));
  }

  const nmAnyPrinting = variants.filter(
    (v) =>
      String(v?.condition || "").toLowerCase() === String(wantCondition || "").toLowerCase() &&
      isFinite(Number(v?.price))
  );
  if (nmAnyPrinting.length) {
    return Math.min(...nmAnyPrinting.map((v) => Number(v.price)));
  }

  const any = variants.filter((v) => isFinite(Number(v?.price)));
  if (!any.length) return null;

  // Last fallback: still take LOWEST available
  return Math.min(...any.map((v) => Number(v.price)));
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

    // Try to pick the closest by name contains
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

    // JustTCG set "id" is a slug (e.g. jungle-pokemon). Use that.
    const setId = picked?.id || picked?.setId || picked?.slug || null;
    debug.justtcg.setLookup.picked = { id: setId, name: picked?.name || picked?.set_name || null };

    return setId || null;
  } catch (e) {
    debug.justtcg.setLookup.http = "FETCH_ERR";
    debug.justtcg.setLookup.error = e?.message || "fetch error";
    return null;
  }
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

  const number = normalizeCollectorNumber(card?.collectorNumber);
  const qLoose = buildLooseQuery(card);

  // Optional set slug lookup (may 500 sometimes; we handle that)
  const setId = await justTCGSetLookup(gameId, card?.set, apiKey, debug);

  const base = "https://api.justtcg.com/v1/cards";

  const attempts = [
    // Most precise: set + number (newer API supports number filter)  [oai_citation:3‡JustTCG](https://justtcg.com/docs)
    setId && number
      ? {
          label: "set+number",
          params: {
            game: gameId,
            set: setId,
            number: String(number),
            limit: "20",
            offset: "0",
            include_price_history: "false",
            include_statistics: "30d",
          },
        }
      : null,

    // Set + q(name)
    setId
      ? {
          label: "set+q",
          params: {
            game: gameId,
            set: setId,
            q: String(card?.name || "").trim(),
            limit: "20",
            offset: "0",
            include_price_history: "false",
            include_statistics: "30d",
          },
        }
      : null,

    // Loose q: name + set + number string
    qLoose
      ? {
          label: "q(loose)",
          params: {
            game: gameId,
            q: qLoose,
            limit: "20",
            offset: "0",
            include_price_history: "false",
            include_statistics: "30d",
          },
        }
      : null,

    // Bare minimum: name only
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
      const entry = {
        label: a.label,
        url,
        http: r.status,
        count: list.length,
        error: !r.ok ? (j?.error?.message || j?.message || j?.error || `HTTP ${r.status}`) : null,
      };
      debug.justtcg.cardAttempts.push(entry);

      if (!r.ok) continue;
      if (!list.length) continue;

      // Rank by name+set similarity
      const wantName = String(card?.name || "").toLowerCase();
      const wantSet = String(card?.set || "").toLowerCase();

      const score = (it) => {
        let s = 0;
        const nm = String(it?.name || "").toLowerCase();
        const st = String(it?.set_name || it?.set || it?.setName || "").toLowerCase();
        if (wantName && nm === wantName) s += 8;
        else if (wantName && nm.includes(wantName)) s += 5;

        if (wantSet && st === wantSet) s += 5;
        else if (wantSet && st.includes(wantSet)) s += 2;

        // If number is present and API returns number/localId field, prefer match
        const itNum = String(it?.number || it?.collectorNumber || it?.localId || "").trim();
        if (number && itNum && itNum === String(number)) s += 4;

        // prefer having variants
        if (Array.isArray(it?.variants) && it.variants.length) s += 1;
        return s;
      };

      const ranked = [...list].sort((x, y) => score(y) - score(x));
      const picked = ranked[0];

      const raw = pickBestVariantPrice(picked, wantPrinting, wantCondition);
      if (!isFinite(raw)) continue;

      // Docs/examples use $ amounts; treat as USD unless API returns otherwise.  [oai_citation:4‡JustTCG](https://justtcg.com/docs)
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
            number: picked?.number || picked?.collectorNumber || picked?.localId || null,
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