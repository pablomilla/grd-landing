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
// These are multipliers on RAW value to estimate graded value.
// You can replace later with real graded comps per grade.
function upliftMultiplier(grade){
  // grade increments of 0.5
  if (grade >= 10) return 3.0;
  if (grade >= 9.5) return 1.9;
  if (grade >= 9.0) return 1.35;
  if (grade >= 8.5) return 1.12;
  if (grade >= 8.0) return 1.08;
  return 1.02;
}

async function getFX(){
  const r = await fetch(`${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : ""}/api/fx`);
  // Above works on Vercel; locally you can just fetch the ECB URL directly or set VERCEL_URL
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j?.error || "FX failed");
  return j; // {base:"EUR", GBP:x, USD:y}
}

// Convert between currencies using ECB rates (EUR base).
// rates: {base:"EUR", GBP, USD}
function convert(amount, from, to, rates){
  if (amount == null || !isFinite(amount)) return null;
  if (from === to) return amount;

  // Build EUR conversion
  // If from is EUR: EUR->to uses rate directly
  // If from is GBP: GBP->EUR = amount / GBP (since GBP = EUR*rateGBP)
  // If from is USD: USD->EUR = amount / USD
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
// NOTE: You must adapt endpoints to your JustTCG plan.
// This function is written to be easy to edit.
// If you paste your JustTCG endpoint format later, you can change it here only.
async function justTCGPrice(card){
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return null;

  // We send a fuzzy query; best practice is: name + setCode/number when possible.
  // Many TCG price providers accept a query string.
  const qParts = [];
  if (card.name) qParts.push(card.name);
  if (card.set) qParts.push(card.set);
  if (card.collectorNumber) qParts.push(`#${card.collectorNumber}`);
  const q = qParts.join(" ").trim();

  if (!q) return null;

  // Placeholder: replace with your JustTCG endpoint.
  // Example shape assumed: {currency:"EUR", market: number}
  const url = `https://api.justtcg.com/v1/prices/search?q=${encodeURIComponent(q)}&limit=1`;

  const r = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json"
    }
  });

  const j = await r.json().catch(()=> ({}));
  if (!r.ok) return null;

  // Attempt to pick a best price field:
  const item = Array.isArray(j.data) ? j.data[0] : (j.data || j.result || null);
  if (!item) return null;

  const currency = item.currency || "EUR";
  const raw =
    Number(item.market ?? item.price ?? item.avg ?? item.low ?? item.mid ?? item.eur ?? item.gbp ?? item.usd);

  if (!isFinite(raw)) return null;

  return { source: "JustTCG", currency, raw };
}

export default async function handler(req, res){
  try{
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const { card, distribution, feeGBP } = await readBody(req);
    if (!card?.game || !card?.name) return json(res, 400, { error: "Missing card" });

    // Fetch raw live price (EU/UK leaning via JustTCG)
    const live = await justTCGPrice(card);

    if (!live){
      return json(res, 200, {
        source: null,
        raw: null,
        currency: null,
        note: "Live pricing unavailable. Use manual raw override."
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
    for (const g of dist){
      const grade = clamp(Number(g.grade||9), 1, 10);
      const prob  = Math.max(0, Number(g.prob||0));
      evGraded += prob * (live.raw * upliftMultiplier(grade));
    }

    // FX conversion (EUR base from ECB)
    // NOTE: live.currency could be EUR/USD/GBP; we convert to GBP/EUR/USD outputs
    const fx = await getFX();

    const out = {
      source: live.source,
      raw: live.raw,
      currency: live.currency,
      evGraded,
      upliftModel: "conservative",
      fx: { base: fx.base, GBP: fx.GBP, USD: fx.USD },
      converted: {}
    };

    const fee = isFinite(Number(feeGBP)) ? Number(feeGBP) : 15;

    // Always provide converted outputs for GBP/EUR/USD
    for (const ccy of ["GBP","EUR","USD"]){
      const rawC = convert(live.raw, live.currency, ccy, fx);
      const evC  = convert(evGraded, live.currency, ccy, fx);
      const feeC = convert(fee, "GBP", ccy, fx);
      out.converted[ccy] = {
        raw: rawC,
        evGraded: evC,
        fee: feeC
      };
    }

    return json(res, 200, out);

  } catch (e){
    console.error(e);
    return json(res, 500, { error: e.message || "Pricing failed" });
  }
}