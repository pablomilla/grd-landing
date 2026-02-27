export const config = { runtime: "nodejs" };

let cache = { at: 0, rates: null };

function json(res, status, body){
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function parseECB(xml){
  // Minimal parse for EUR reference rates
  // We extract USD + GBP (and a few others if present)
  const rate = (ccy) => {
    const re = new RegExp(`currency=['"]${ccy}['"][^>]*rate=['"]([0-9.]+)['"]`, "i");
    const m = xml.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    base: "EUR",
    GBP: rate("GBP"),
    USD: rate("USD")
  };
}

// returns EUR->CCY rates
export default async function handler(req, res){
  try{
    const now = Date.now();
    if (cache.rates && (now - cache.at) < 1000*60*60*12){
      return json(res, 200, { source:"ECB", cached:true, ...cache.rates });
    }

    const r = await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml");
    const xml = await r.text();
    const rates = parseECB(xml);

    if (!rates.GBP || !rates.USD){
      return json(res, 500, { error: "FX parse failed" });
    }

    cache = { at: now, rates };
    return json(res, 200, { source:"ECB", cached:false, ...rates });
  } catch (e){
    console.error(e);
    return json(res, 500, { error: e.message || "FX failed" });
  }
}