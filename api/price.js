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

// --- Conservative uplift curve (tune later) ---
function upliftMultiplier(grade){
  if (grade >= 10) return 3.0;
  if (grade >= 9.5) return 1.9;
  if (grade >= 9.0) return 1.35;
  if (grade >= 8.5) return 1.12;
  if (grade >= 8.0) return 1.08;
  return 1.02;
}

// --- FX via your /api/fx (ECB-backed) ---
async function getFX(){
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "";
  const r = await fetch(`${base}/api/fx`);
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j?.error || "FX failed");
  return j; // { base:"EUR", GBP:x, USD:y }
}

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

  return fromEUR(toEUR(amount, from), to);
}

// --------------------
// JustTCG helpers
// --------------------
function justtcgHeaders(){
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return null;
  return {
    "x-api-key": apiKey,
    "accept": "application/json"
  };
}

function normalizeGame(game){
  const g = String(game || "").toLowerCase();
  if (g === "mtg") return "mtg";
  if (g === "yugioh") return "yugioh";
  if (g === "pokemon") return "pokemon";
  return null;
}

// Pick a set id from /v1/sets search
async function justTCGResolveSetId({ game, setName }, debug){
  if (!setName) return null;
  const headers = justtcgHeaders();
  if (!headers) return null;

  const url = `https://api.justtcg.com/v1/sets?q=${encodeURIComponent(setName)}&game=${encodeURIComponent(game)}&limit=10`;
  debug.justtcg.setLookup = { url };

  const r = await fetch(url, { headers });
  const j = await r.json().catch(()=> ({}));
  debug.justtcg.setLookup.http = r.status;

  const arr = Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : []);
  debug.justtcg.setLookup.count = arr.length;

  if (!r.ok || !arr.length) return null;

  // heuristic: closest name match first
  const sn = String(setName).toLowerCase();
  const best = [...arr].sort((a,b)=>{
    const an = String(a?.name || "").toLowerCase();
    const bn = String(b?.name || "").toLowerCase();
    const as = an.includes(sn) ? 2 : 0;
    const bs = bn.includes(sn) ? 2 : 0;
    return bs - as;
  })[0];

  // Docs describe "id" for games; sets typically have an id/slug too.
  return best?.id || best?.setId || best?.slug || null;
}

// Fetch a price from /v1/cards
async function justTCGPrice(card, debug){
  const headers = justtcgHeaders();
  if (!headers) return null;

  const game = normalizeGame(card?.game);
  if (!game) return null;

  const name = String(card?.name || "").trim();
  if (!name) return null;

  // Resolve set id if we have a set name
  const setName = card?.set ? String(card.set).trim() : null;
  const setId = await justTCGResolveSetId({ game, setName }, debug);

  const qParts = [name];
  // collector number can help, but not all datasets index it consistently; keep it light
  if (card?.collectorNumber) qParts.push(String(card.collectorNumber).trim());

  const q = qParts.join(" ").trim();

  // Use the endpoint style from JustTCG docs/blog: /v1/cards with q + game + set
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("game", game);
  if (setId) params.set("set", setId);
  params.set("condition", "NM");
  params.set("limit", "10");

  const url = `https://api.justtcg.com/v1/cards?${params.toString()}`;

  debug.justtcg.cards = { url, q, game, setId };

  const r = await fetch(url, { headers });
  const j = await r.json().catch(()=> ({}));
  debug.justtcg.cards.http = r.status;

  const items = Array.isArray(j?.data) ? j.data : [];
  debug.justtcg.cards.count = items.length;

  if (!r.ok || !items.length) return null;

  // Try to find a numeric price field (provider-dependent). Common pattern is cents.
  function getPrice(x){
    const cents =
      x?.market_price_cents ??
      x?.marketPriceCents ??
      x?.price_cents ??
      x?.priceCents ??
      null;

    if (isFinite(Number(cents))) return Number(cents) / 100;

    const p =
      x?.market_price ??
      x?.marketPrice ??
      x?.price ??
      x?.avg_price ??
      null;

    if (isFinite(Number(p))) return Number(p);

    return null;
  }

  // Choose first item with a price
  let chosen = null;
  let raw = null;
  for (const it of items){
    const p = getPrice(it);
    if (p != null){
      chosen = it;
      raw = p;
      break;
    }
  }
  if (!chosen || raw == null) return null;

  // Currency is typically included; if not, assume EUR (EU-leaning).
  const currency = chosen?.currency || "EUR";

  return {
    source: "JustTCG",
    currency,
    raw,
    matched: {
      name: chosen?.name || chosen?.card_name || null,
      set: chosen?.set?.name || chosen?.set_name || null,
      id: chosen?.variantId || chosen?.id || null
    }
  };
}

export default async function handler(req, res){
  try{
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const { card, distribution, feeGBP } = await readBody(req);
    if (!card?.game || !card?.name) return json(res, 400, { error: "Missing card" });

    const debug = { justtcg: {} };

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

    const dist = Array.isArray(distribution) && distribution.length
      ? distribution
      : [
          {grade: 8.5, prob: 0.2},
          {grade: 9.0, prob: 0.5},
          {grade: 9.5, prob: 0.25},
          {grade: 10.0, prob: 0.05}
        ];

    let evGraded = 0;
    for (const g of dist){
      const grade = clamp(Number(g.grade||9), 1, 10);
      const prob  = Math.max(0, Number(g.prob||0));
      evGraded += prob * (live.raw * upliftMultiplier(grade));
    }

    const fx = await getFX();
    const fee = isFinite(Number(feeGBP)) ? Number(feeGBP) : 15;

    const out = {
      source: live.source,
      raw: live.raw,
      currency: live.currency,
      evGraded,
      upliftModel: "conservative",
      fx: { base: fx.base, GBP: fx.GBP, USD: fx.USD },
      converted: {},
      matched: live.matched || null,
      debug
    };

    for (const ccy of ["GBP","EUR","USD"]){
      out.converted[ccy] = {
        raw: convert(live.raw, live.currency, ccy, fx),
        evGraded: convert(evGraded, live.currency, ccy, fx),
        fee: convert(fee, "GBP", ccy, fx)
      };
    }

    return json(res, 200, out);
  } catch (e){
    console.error(e);
    return json(res, 500, { error: e.message || "Pricing failed" });
  }
}