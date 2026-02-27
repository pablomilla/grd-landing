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

async function openaiVisionExtract({ frontDataUrl, backDataUrl }){
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");

  const system = `You are a trading card identification assistant for: Pokemon, Magic: The Gathering, and Yu-Gi-Oh.
Return ONLY valid JSON matching the schema. Do not include markdown.`;

  const user = {
    type: "text",
    text:
`Extract card identity fields from the provided images.
Focus on FRONT for name, set, collector number / set code, variant (foil/holo/reverse/etched/1st edition), language, and any edition markers.
If unsure, return best guess and lower confidence.

Return JSON with:
{
  "game": "pokemon"|"mtg"|"yugioh"|"unknown",
  "name": string|null,
  "set": string|null,           // set name or set code if available
  "setCode": string|null,       // e.g. MTG set code, or Yu-Gi-Oh set code like LOB-000
  "collectorNumber": string|null, // Pokemon or MTG collector number if visible
  "variant": string|null,       // e.g. "holo", "reverse holo", "foil", "etched", "1st edition"
  "language": string|null,      // e.g. "English"
  "confidence": number          // 0..1
}`
  };

  const content = [
    user,
    { type:"image_url", image_url: { url: frontDataUrl } },
    { type:"image_url", image_url: { url: backDataUrl } }
  ];

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        { role:"system", content: system },
        { role:"user", content }
      ],
      temperature: 0.2,
      max_output_tokens: 500
    })
  });

  const data = await resp.json().catch(()=> ({}));
  if (!resp.ok){
    throw new Error(data?.error?.message || "OpenAI identify failed");
  }

  // Extract text output
  const out = (data.output || []).flatMap(o => o.content || []);
  const text = out.map(c => c.text).filter(Boolean).join("\n").trim();

  let parsed;
  try{ parsed = JSON.parse(text); } catch(e){
    throw new Error("Identify: model did not return valid JSON");
  }

  parsed.confidence = clamp(Number(parsed.confidence || 0), 0, 1);
  return parsed;
}

// --- Canonical resolution helpers ---

async function resolveMTG({ name, setCode, collectorNumber }){
  // Use Scryfall search
  // Prefer collector number + set code if available
  const params = [];
  if (name) params.push(`!"${name.replace(/"/g,'')}"`);
  if (setCode) params.push(`set:${setCode}`);
  if (collectorNumber) params.push(`number:${collectorNumber}`);

  const q = params.length ? params.join(" ") : (name ? `!"${name.replace(/"/g,'')}"` : "");
  if (!q) return [];

  const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released`;
  const r = await fetch(url);
  const j = await r.json().catch(()=> ({}));
  if (!r.ok || !j?.data) return [];

  return j.data.slice(0, 8).map(card => ({
    game: "mtg",
    name: card.name,
    displayName: card.name,
    set: card.set_name,
    setCode: card.set,
    collectorNumber: String(card.collector_number || ""),
    variant: card.foil ? "foil-available" : "nonfoil",
    language: card.lang || "en",
    canonical: {
      provider: "scryfall",
      id: card.id,
      scryfall_uri: card.scryfall_uri
    },
    confidence: 0.65
  }));
}

async function resolveYugioh({ name, setCode }){
  // YGOPRODeck: if set code known, use cardinfo?cardset=... doesn't exist; easiest is search by name
  if (!name && !setCode) return [];
  const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(name || setCode)}`;
  const r = await fetch(url);
  const j = await r.json().catch(()=> ({}));
  if (!r.ok || !j?.data) return [];

  const candidates = [];
  for (const c of j.data.slice(0, 6)){
    // Find matching set code if provided
    let bestSet = null;
    if (Array.isArray(c.card_sets) && c.card_sets.length){
      if (setCode){
        bestSet = c.card_sets.find(s => (s.set_code || "").toUpperCase() === String(setCode).toUpperCase()) || c.card_sets[0];
      } else {
        bestSet = c.card_sets[0];
      }
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
      canonical: {
        provider: "ygoprodeck",
        id: String(c.id),
        ygo_url: c.ygoprodeck_url
      },
      confidence: 0.62
    });
  }
  return candidates;
}

async function resolvePokemon({ name, set, setCode, collectorNumber }){
  // PokémonTCG.io (no Cardmarket needed)
  // Prefer number + set code, but this API uses set.id, set.name; we'll search by name + number + set name guess
  if (!name) return [];
  const apiKey = process.env.POKETCG_API_KEY;

  const q = [];
  q.push(`name:"${name.replace(/"/g,'')}"`);
  if (collectorNumber) q.push(`number:"${collectorNumber.replace(/"/g,'')}"`);
  if (setCode) q.push(`set.ptcgoCode:"${setCode.replace(/"/g,'')}"`);
  if (set) q.push(`set.name:"${set.replace(/"/g,'')}"`);

  const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q.join(" "))}&pageSize=8`;
  const r = await fetch(url, {
    headers: apiKey ? { "X-Api-Key": apiKey } : {}
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok || !j?.data) return [];

  return j.data.slice(0, 8).map(c => ({
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

  // match set code
  if (extracted.setCode && cand.setCode && String(extracted.setCode).toLowerCase() === String(cand.setCode).toLowerCase()) score += 0.18;
  // match collector number
  if (extracted.collectorNumber && cand.collectorNumber && String(extracted.collectorNumber).toLowerCase() === String(cand.collectorNumber).toLowerCase()) score += 0.18;
  // match set name approx
  if (extracted.set && cand.set && String(cand.set).toLowerCase().includes(String(extracted.set).toLowerCase())) score += 0.10;

  // variant hints
  if (extracted.variant && cand.variant && String(cand.variant).toLowerCase().includes(String(extracted.variant).toLowerCase())) score += 0.08;

  return clamp(score, 0, 0.99);
}

export default async function handler(req, res){
  try{
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const { frontDataUrl, backDataUrl } = await readBody(req);
    if (!frontDataUrl || !backDataUrl) return json(res, 400, { error: "Missing frontDataUrl/backDataUrl" });

    const extracted = await openaiVisionExtract({ frontDataUrl, backDataUrl });

    let candidates = [];
    const game = extracted.game;

    if (game === "mtg"){
      candidates = await resolveMTG(extracted);
    } else if (game === "yugioh"){
      candidates = await resolveYugioh(extracted);
    } else if (game === "pokemon"){
      candidates = await resolvePokemon(extracted);
    } else {
      // try all, then sort
      const [m, y, p] = await Promise.all([
        resolveMTG(extracted),
        resolveYugioh(extracted),
        resolvePokemon(extracted),
      ]);
      candidates = [...m, ...y, ...p];
    }

    // boost confidences using extracted matches, then sort
    candidates = candidates.map(c => ({
      ...c,
      confidence: boostByMatch(extracted, c)
    })).sort((a,b)=> (b.confidence||0) - (a.confidence||0));

    // If nothing, return extracted only
    if (!candidates.length){
      return json(res, 200, {
        extracted,
        candidates: []
      });
    }

    // return top candidates
    return json(res, 200, {
      extracted,
      candidates: candidates.slice(0, 6)
    });

  } catch (e){
    console.error(e);
    return json(res, 500, { error: e.message || "Identify failed" });
  }
}