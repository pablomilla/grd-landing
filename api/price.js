// /api/price.js
export const config = { runtime: "nodejs" };

function json(res, status, body){
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req){
  return await new Promise((resolve, reject)=>{
    let data = "";
    req.on("data", c => data += c);
    req.on("end", ()=> {
      try{ resolve(JSON.parse(data || "{}")); } catch(e){ reject(e); }
    });
  });
}

function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

// Conservative uplift curve (tune later)
function upliftMultiplier(grade){
  if (grade >= 10) return 3.0;
  if (grade >= 9.5) return 1.9;
  if (grade >= 9.0) return 1.35;
  if (grade >= 8.5) return 1.12;
  if (grade >= 8.0) return 1.08;
  return 1.02;
}

/**
 * FIX A: Fetch ECB FX directly (no /api/fx dependency)
 * Returns { base:"EUR", GBP:number, USD:number }
 */
async function getFX(){
  const r = await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", {
    headers: { "accept": "application/xml,text/xml,*/*" }
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`FX failed (HTTP ${r.status})`);

  const getRate = (ccy) => {
    const m = txt.match(new RegExp(`currency='${ccy}'\\s+rate='([0-9.]+)'`));
    return m ? Number(m[1]) : null;
  };

  const GBP = getRate("GBP");
  const USD = getRate("USD");
  if (!GBP || !USD) throw new Error("FX failed (missing GBP/USD rates)");

  return { base: "EUR", GBP, USD, source: "ECB" };
}

// Convert between currencies using ECB rates (EUR base).
function convert(amount, from, to, rates){
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

/**
 * JustTCG (primary)
 * Your debug shows you're using an endpoint like:
 *   https://api.justtcg.com/v1/cards?q=...&game=Pokemon&condition=NM&printing=Normal...
 *
 * This function assumes JustTCG returns:
 *  - either { data: [ ... ] } or { result: ... }
 *  - and an item has some numeric price field we can read.
 *
 * IMPORTANT: You may need to adjust the parsing to match your JustTCG response shape.
 */
async function justTCGPrice(card, debug){
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return null;

  const qParts = [];
  if (card.name) qParts.push(card.name);
  if (card.set) qParts.push(card.set);
  if (card.collectorNumber) qParts.push(String(card.collectorNumber));
  const q = qParts.join(" ").trim();
  if (!q) return null;

  const game =
    card.game === "pokemon" ? "Pokemon" :
    card.game === "mtg" ? "Magic" :
    card.game === "yugioh" ? "YuGiOh" :
    (card.game || "Pokemon");

  // If your plan supports region filters, add them here (UK/EU preference).
  const url =
    `https://api.justtcg.com/v1/cards` +
    `?q=${encodeURIComponent(q)}` +
    `&game=${encodeURIComponent(game)}` +
    `&condition=NM` +
    `&printing=Normal` +
    `&include_price_history=false` +
    `&include_statistics=30d`;

  if (debug){
    debug.justtcg = { url, q, game, http: null, count: 0, picked: null };
  }

  const r = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json"
    }
  });

  const j = await r.json().catch(()=> ({}));
  if (debug) debug.justtcg.http = r.status;
  if (!r.ok) return null;

  // Try common response shapes
  const list =
    Array.isArray(j?.data) ? j.data :
    Array.isArray(j?.results) ? j.results :
    Array.isArray(j?.cards) ? j.cards :
    [];

  if (debug) debug.justtcg.count = list.length;
  if (!list.length) return null;

  // Pick the best candidate (first) and extract a usable price
  const item = list[0];

  // Try a bunch of possible fields (adapt if your API differs)
  const raw =
    Number(
      item.market ??
      item.price ??
      item.avg ??
      item.mid ??
      item.low ??
      item.fair_market_value ??
      item?.prices?.market ??
      item?.prices?.avg ??
      item?.price_statistics?.avg ??
      item?.statistics_30d?.avg ??
      item?.statistics?.avg
    );

  // Currency guess:
  const currency =
    item.currency ||
    item?.prices?.currency ||
    item?.price_currency ||
    "EUR";

  if (!isFinite(raw)) {
    if (debug) debug.justtcg.picked = { note: "No numeric price field found on first item." };
    return null;
  }

  if (debug) {
    debug.justtcg.picked = {
      name: item.name || item.title || null,
      set: item.set || item.set_name || null,
      raw,
      currency
    };
  }

  return { source: "JustTCG", currency, raw };
}

export default async function handler(req, res){
  try{
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const { card, distribution, feeGBP } = await readBody(req);
    if (!card?.game || !card?.name) return json(res, 400, { error: "Missing card (game + name required)" });

    const debug = { justtcg: null };

    // 1) Raw live price
    const live = await justTCGPrice(card, debug);

    if (!live){
      return json(res, 200, {
        source: null,
        raw: null,
        currency: null,
        note: "Live pricing unavailable. Use manual raw override.",
        debug
      });
    }

    // 2) EV graded using distribution + uplift curve
    const dist = Array.isArray(distribution) && distribution.length
      ? distribution
      : [
          {grade: 8.5, prob: 0.2},
          {grade: 9.0, prob: 0.5},
          {grade: 9.5, prob: 0.25},
          {grade: 10.0, prob: 0.05}
        ];

    let probSum = 0;
    for (const g of dist) probSum += Math.max(0, Number(g.prob || 0));
    if (probSum <= 0) probSum = 1;

    let evGraded = 0;
    for (const g of dist){
      const grade = clamp(Number(g.grade||9), 1, 10);
      const prob  = Math.max(0, Number(g.prob||0)) / probSum;
      evGraded += prob * (live.raw * upliftMultiplier(grade));
    }

    // 3) FX conversion (ECB direct)
    const fx = await getFX();

    const out = {
      source: live.source,
      raw: live.raw,
      currency: live.currency,
      evGraded,
      upliftModel: "conservative",
      fx: { base: fx.base, GBP: fx.GBP, USD: fx.USD, source: fx.source },
      converted: {},
      debug
    };

    const fee = isFinite(Number(feeGBP)) ? Number(feeGBP) : 15;

    // Always provide converted outputs for GBP/EUR/USD
    for (const ccy of ["GBP","EUR","USD"]){
      const rawC = convert(live.raw, live.currency, ccy, fx);
      const evC  = convert(evGraded, live.currency, ccy, fx);
      const feeC = convert(fee, "GBP", ccy, fx);
      out.converted[ccy] = { raw: rawC, evGraded: evC, fee: feeC };
    }

    return json(res, 200, out);

  } catch (e){
    console.error(e);
    return json(res, 500, { error: e.message || "Pricing failed" });
  }
}