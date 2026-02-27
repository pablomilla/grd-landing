export const config = { runtime: "nodejs" };

function json(res, status, body){
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req){
  return await new Promise((resolve, reject)=>{
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", ()=> {
      try{ resolve(JSON.parse(data || "{}")); } catch(e){ reject(e); }
    });
  });
}

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function getOutputText(respJson){
  const items = respJson?.output || [];
  for (const item of items){
    if (item.type === "message" && Array.isArray(item.content)){
      const parts = item.content
        .filter(p => p.type === "output_text" && typeof p.text === "string")
        .map(p => p.text);
      if (parts.length) return parts.join("\n").trim();
    }
  }
  if (typeof respJson?.output_text === "string") return respJson.output_text.trim();
  return "";
}

function normalizePokemonExtract(ex){
  const out = { ...ex };

  // Normalize collector number: "11/108" -> "11"
  if (typeof out.collectorNumber === "string" && out.collectorNumber.includes("/")){
    out.collectorNumber = out.collectorNumber.split("/")[0].trim();
  }
  // Sometimes model returns "Base" or "XY" — keep but don’t trust it as ptcgoCode.
  // We'll use set name + set lookup instead.
  if (typeof out.setCode === "string"){
    out.setCode = out.setCode.trim();
    if (!out.setCode) out.setCode = null;
  }
  if (typeof out.set === "string"){
    out.set = out.set.trim();
    if (!out.set) out.set = null;
  }
  if (typeof out.name === "string"){
    out.name = out.name.trim();
    if (!out.name) out.name = null;
  }
  return out;
}

async function openaiVisionExtract({ frontDataUrl, backDataUrl }){
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");

  const system = `You identify trading cards (Pokemon, Magic: The Gathering, Yu-Gi-Oh).
Return ONLY valid JSON, no markdown.`;

  const userText = `Extract card identity fields from the provided images.

Priority:
- Use FRONT for name and identifiers.
- For Pokemon: collectorNumber should be the left-side number only (e.g. "11" not "11/108").
- setCode is optional; if uncertain, return null.

Return JSON:
{
  "game": "pokemon"|"mtg"|"yugioh"|"unknown",
  "name": string|null,
  "set": string|null,
  "setCode": string|null,
  "collectorNumber": string|null,
  "variant": string|null,
  "language": string|null,
  "confidence": number
}`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: system }]
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: userText },
            { type: "input_image", image_url: frontDataUrl },
            { type: "input_image", image_url: backDataUrl }
          ]
        }
      ],
      temperature: 0.2,
      max_output_tokens: 500
    })
  });

  const data = await resp.json().catch(()=> ({}));
  if (!resp.ok){
    throw new Error(data?.error?.message || "OpenAI identify failed");
  }

  const text = getOutputText(data);
  if (!text) throw new Error("Identify: no output_text returned");

  let parsed;
  try{ parsed = JSON.parse(text); } catch(e){
    throw new Error("Identify: model did not return valid JSON");
  }

  parsed.confidence = clamp(Number(parsed.confidence || 0), 0, 1);
  return parsed;
}

// ---------- RESOLVERS ----------

async function resolveMTG({ name, setCode, collectorNumber }){
  if (!name) return [];

  const safeName = name.replace(/"/g,'').trim();
  async function fetchQ(q){
    const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released`;
    const r = await fetch(url);
    const j = await r.json().catch(()=> ({}));
    if (!r.ok || !j?.data) return [];
    return j.data;
  }

  const partsA = [`!"${safeName}"`];
  if (setCode) partsA.push(`set:${setCode}`);
  if (collectorNumber) partsA.push(`number:${collectorNumber}`);
  let data = await fetchQ(partsA.join(" "));

  if (!data.length){
    const partsB = [`name:"${safeName}"`];
    if (setCode) partsB.push(`set:${setCode}`);
    data = await fetchQ(partsB.join(" "));
  }
  if (!data.length) data = await fetchQ(`"${safeName}"`);
  if (!data.length) return [];

  return data.slice(0, 8).map(card => ({
    game: "mtg",
    name: card.name,
    displayName: card.name,
    set: card.set_name,
    setCode: card.set,
    collectorNumber: String(card.collector_number || ""),
    variant: card.foil ? "foil-available" : "nonfoil",
    language: card.lang || "en",
    canonical: { provider: "scryfall", id: card.id, scryfall_uri: card.scryfall_uri },
    confidence: 0.65
  }));
}

async function resolveYugioh({ name, setCode }){
  if (!name && !setCode) return [];
  const q = name || setCode;

  const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(q)}`;
  const r = await fetch(url);
  const j = await r.json().catch(()=> ({}));
  if (!r.ok || !j?.data) return [];

  const candidates = [];
  for (const c of j.data.slice(0, 6)){
    let bestSet = null;
    if (Array.isArray(c.card_sets) && c.card_sets.length){
      if (setCode){
        bestSet = c.card_sets.find(s => (s.set_code || "").toUpperCase() === String(setCode).toUpperCase()) || c.card_sets[0];
      } else bestSet = c.card_sets[0];
    }
    candidates.push({
      game: "yugioh",
      name: c.name,
      displayName: c.name,
      set: bestSet?.set_name || null,
      setCode: bestSet?.set_code || null,
      collectorNumber: null,
      variant: bestSet?.set_rarity || null,
      language: "en",
      canonical: { provider: "ygoprodeck", id: String(c.id), ygo_url: c.ygoprodeck_url },
      confidence: 0.62
    });
  }
  return candidates;
}

async function pokemonSetLookup(setName, apiKey){
  if (!setName) return [];
  const headers = apiKey ? { "X-Api-Key": apiKey } : {};
  // broad set search; we’ll match client-side
  const url = `https://api.pokemontcg.io/v2/sets?q=${encodeURIComponent(`name:"${setName.replace(/"/g,"")}"`) }&pageSize=12`;
  const r = await fetch(url, { headers });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok || !j?.data) return [];
  return j.data;
}

async function resolvePokemon(extracted){
  const apiKey = process.env.POKETCG_API_KEY;
  const headers = apiKey ? { "X-Api-Key": apiKey } : {};

  const name = extracted.name;
  if (!name) return [];

  const safeName = name.replace(/"/g,'').trim();
  const num = extracted.collectorNumber ? String(extracted.collectorNumber).replace(/"/g,'').trim() : null;
  const setName = extracted.set ? String(extracted.set).replace(/"/g,'').trim() : null;

  async function fetchCards(q){
    const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=10`;
    const r = await fetch(url, { headers });
    const j = await r.json().catch(()=> ({}));
    if (!r.ok || !j?.data) return [];
    return j.data;
  }

  // If we have a set name, try mapping it to set.id(s) first (most reliable).
  let setIds = [];
  if (setName){
    const sets = await pokemonSetLookup(setName, apiKey);
    const target = setName.toLowerCase();
    // keep close matches
    setIds = sets
      .filter(s => (s?.name || "").toLowerCase().includes(target) || target.includes((s?.name || "").toLowerCase()))
      .map(s => s.id)
      .slice(0, 4);
  }

  let data = [];

  // A) set.id + number + name
  if (setIds.length && num){
    for (const sid of setIds){
      data = await fetchCards(`name:"${safeName}" set.id:"${sid}" number:"${num}"`);
      if (data.length) break;
    }
  }

  // B) set name + number + name
  if (!data.length && setName && num){
    data = await fetchCards(`name:"${safeName}" set.name:"${setName}" number:"${num}"`);
  }

  // C) name + number
  if (!data.length && num){
    data = await fetchCards(`name:"${safeName}" number:"${num}"`);
  }

  // D) name only (broad)
  if (!data.length){
    data = await fetchCards(`name:"${safeName}"`);
  }

  if (!data.length) return [];

  return data.slice(0, 8).map(c => ({
    game: "pokemon",
    name: c.name,
    displayName: c.name,
    set: c.set?.name || null,
    setCode: c.set?.ptcgoCode || c.set?.id || null,
    collectorNumber: String(c.number || ""),
    variant: c.rarity || null,
    language: "en",
    canonical: {
      provider: "pokemontcg.io",
      id: c.id,
      image: c.images?.large || c.images?.small || null
    },
    confidence: 0.66
  }));
}

function boostByMatch(extracted, cand){
  let score = cand.confidence || 0.5;

  if (extracted.collectorNumber && cand.collectorNumber && String(extracted.collectorNumber).toLowerCase() === String(cand.collectorNumber).toLowerCase()) score += 0.22;
  if (extracted.set && cand.set && String(cand.set).toLowerCase().includes(String(extracted.set).toLowerCase())) score += 0.10;
  if (extracted.variant && cand.variant && String(cand.variant).toLowerCase().includes(String(extracted.variant).toLowerCase())) score += 0.06;

  return clamp(score, 0, 0.99);
}

export default async function handler(req, res){
  try{
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const { frontDataUrl, backDataUrl } = await readBody(req);
    if (!frontDataUrl || !backDataUrl) return json(res, 400, { error: "Missing frontDataUrl/backDataUrl" });

    let extracted = await openaiVisionExtract({ frontDataUrl, backDataUrl });

    // Normalize for Pokemon to avoid "11/108" etc.
    if (extracted?.game === "pokemon") extracted = normalizePokemonExtract(extracted);

    let candidates = [];
    const game = extracted.game;

    if (game === "mtg"){
      candidates = await resolveMTG(extracted);
    } else if (game === "yugioh"){
      candidates = await resolveYugioh(extracted);
    } else if (game === "pokemon"){
      candidates = await resolvePokemon(extracted);
    } else {
      const [m, y, p] = await Promise.all([
        resolveMTG(extracted),
        resolveYugioh(extracted),
        resolvePokemon(normalizePokemonExtract(extracted))
      ]);
      candidates = [...m, ...y, ...p];
    }

    candidates = candidates.map(c => ({
      ...c,
      confidence: boostByMatch(extracted, c)
    })).sort((a,b)=> (b.confidence||0) - (a.confidence||0));

    return json(res, 200, {
      extracted,
      candidates: candidates.slice(0, 6),
      debug: {
        normalizedCollectorNumber: extracted.collectorNumber || null,
        usedSetName: extracted.set || null
      }
    });

  } catch (e){
    console.error(e);
    return json(res, 500, { error: "Identify failed", detail: e?.message || String(e) });
  }
}