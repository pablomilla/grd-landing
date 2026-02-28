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
  if (grade >= 10)  return 3.0;
  if (grade >= 9.5) return 1.9;
  if (grade >= 9.0) return 1.35;
  if (grade >= 8.5) return 1.12;
  if (grade >= 8.0) return 1.08;
  return 1.02;
}

async function fetchWithTimeout(url, options = {}, ms = 12000){
  const ctrl = new AbortController();
  const t = setTimeout(()=> ctrl.abort(), ms);
  try{
    const r = await fetch(url, { ...options, signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

// --- ECB FX (EUR base) ---
// Returns { base:"EUR", GBP:number, USD:number, EUR:1 }
async function getFX_ECB(){
  // ECB “eurofxref-daily.xml”
  const url = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
  const r = await fetchWithTimeout(url, {}, 12000);
  const xml = await r.text();

  if (!r.ok || !xml) throw new Error("FX failed");

  // Minimal XML parsing (no deps). We only need USD + GBP.
  const readRate = (ccy) => {
    const re = new RegExp(`currency=['"]${ccy}['"]\\s+rate=['"]([^'"]+)['"]`, "i");
    const m = xml.match(re);
    return m ? Number(m[1]) : null;
  };

  const USD = readRate("USD");
  const GBP = readRate("GBP");
  if (!USD || !GBP) throw new Error("FX parse failed");

  return { base:"EUR", EUR: 1, USD, GBP };
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

// --- JustTCG (primary) ---
// Uses /v1/cards search. Price is in variants[].price.  [oai_citation:3‡JustTCG](https://justtcg.com/docs)
// NOTE: JustTCG prices are typically tied to their underlying market source (often USD-like).
async function justTCGPrice(card, debug){
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return null;

  const gameRaw = String(card.game || "").toLowerCase();
  const game =
    gameRaw === "pokemon" ? "Pokemon" :
    gameRaw === "mtg" ? "Magic" :
    gameRaw === "yugioh" ? "YuGiOh" :
    null;

  // Build a strong query:
  // name + set + number helps a lot
  const qParts = [];
  if (card.name) qParts.push(String(card.name));
  if (card.set) qParts.push(String(card.set));
  if (card.collectorNumber) qParts.push(String(card.collectorNumber));
  const q = qParts.join(" ").trim();
  if (!q) return null;

  // Prefer NM + Normal to approximate “raw NM”
  // JustTCG supports condition & printing filters.  [oai_citation:4‡JustTCG](https://justtcg.com/docs)
  const params = new URLSearchParams();
  params.set("q", q);
  if (game) params.set("game", game);
  params.set("condition", "NM");
  params.set("printing", "Normal");
  params.set("include_price_history", "false");
  params.set("include_statistics", "30d");

  const url = `https://api.justtcg.com/v1/cards?${params.toString()}`;

  debug.justtcg = { url, q, game };

  const r = await fetchWithTimeout(url, {
    headers: {
      "X-Api-Key": apiKey,
      "Accept": "application/json"
    }
  }, 12000);

  const j = await r.json().catch(()=> ({}));
  debug.justtcg.http = r.status;

  if (!r.ok) {
    debug.justtcg.error = j?.error || j?.message || `HTTP ${r.status}`;
    return null;
  }

  const cards = Array.isArray(j?.data) ? j.data : [];
  debug.justtcg.count = cards.length;

  if (!cards.length) return null;

  // Pick best match by:
  // exact number match > set match > first result
  const wantNum = card.collectorNumber ? String(card.collectorNumber).trim() : null;
  const wantSet = card.set ? String(card.set).toLowerCase() : null;

  const score = (c) => {
    let s = 0;
    const n = String(c.number || "").trim();
    const setName = String(c.set_name || c.set || "").toLowerCase();
    if (wantNum && n === wantNum) s += 10;
    if (wantSet && setName.includes(wantSet)) s += 4;
    if (setName) s += 1;
    return s;
  };

  const bestCard = [...cards].sort((a,b)=>score(b)-score(a))[0];
  const variants = Array.isArray(bestCard?.variants) ? bestCard.variants : [];
  if (!variants.length) return null;

  // We requested NM+Normal filtering — but if API ignores filter on some plans,
  // still pick the best candidate:
  const preferred = variants.find(v =>
    String(v.condition || "").toLowerCase().includes("near") &&
    String(v.printing || "").toLowerCase() === "normal" &&
    isFinite(Number(v.price))
  ) || variants.find(v => isFinite(Number(v.price)));

  if (!preferred) return null;

  const raw = Number(preferred.price);
  if (!isFinite(raw)) return null;

  // JustTCG doesn’t include explicit currency in the card object example;
  // most integrations treat it as USD-like market price.
  // If your JustTCG plan provides currency elsewhere, wire it in here.
  const currency = "USD";

  return {
    source: "JustTCG",
    currency,
    raw,
    picked: {
      cardId: bestCard.id,
      set_name: bestCard.set_name || null,
      number: bestCard.number || null,
      variantId: preferred.id || null,
      condition: preferred.condition || null,
      printing: preferred.printing || null
    }
  };
}

export default async function handler(req, res){
  try{
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const { card, distribution, feeGBP } = await readBody(req);
    if (!card?.game || !card?.name) return json(res, 400, { error: "Missing card" });

    const debug = {};

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

    // Compute EV graded using distribution + uplift curve on RAW
    const dist = Array.isArray(distribution) && distribution.length
      ? distribution
      : [
          {grade: 8.5, prob: 0.2},
          {grade: 9.0, prob: 0.5},
          {grade: 9.5, prob: 0.25},
          {grade: 10.0, prob: 0.05}
        ];

    let evGraded = 0;
    let sumProb = 0;
    for (const g of dist){
      const grade = clamp(Number(g.grade||9), 1, 10);
      const prob  = Math.max(0, Number(g.prob||0));
      sumProb += prob;
      evGraded += prob * (live.raw * upliftMultiplier(grade));
    }
    if (sumProb > 0 && Math.abs(sumProb - 1) > 0.01) {
      // normalize if needed
      evGraded = evGraded / sumProb;
    }

    const fx = await getFX_ECB();

    const out = {
      source: live.source,
      raw: live.raw,
      currency: live.currency,
      evGraded,
      upliftModel: "conservative",
      fx: { base: fx.base, GBP: fx.GBP, USD: fx.USD },
      picked: live.picked || null,
      converted: {},
      debug
    };

    const fee = isFinite(Number(feeGBP)) ? Number(feeGBP) : 15;

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