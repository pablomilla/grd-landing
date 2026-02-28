// /api/identify.js
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

function normalizeCollectorNumber(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.includes("/")) return s.split("/")[0].trim(); // "11/108" -> "11"
  return s;
}

function pickBestExtract(extracted) {
  if (extracted && !Array.isArray(extracted)) return extracted;
  if (Array.isArray(extracted) && extracted.length) {
    const sorted = [...extracted].sort(
      (a, b) => Number(b?.confidence || 0) - Number(a?.confidence || 0)
    );
    return sorted[0];
  }
  return {
    game: "unknown",
    name: null,
    set: null,
    setCode: null,
    collectorNumber: null,
    variant: null,
    language: null,
    confidence: 0,
  };
}

function extractOutputText(respJson) {
  // Responses API: output -> content[] with type "output_text"
  const out = Array.isArray(respJson?.output) ? respJson.output : [];
  const chunks = [];
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") {
        chunks.push(c.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

/** ------------------------------
 * OpenAI extract (Responses API)
 * ------------------------------ */
async function openaiVisionExtract({ frontDataUrl, backDataUrl }, debug) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");

  const systemText =
    `You are a trading card identification assistant for: Pokemon, Magic: The Gathering, and Yu-Gi-Oh.\n` +
    `Return ONLY valid JSON matching the schema. Do not include markdown.\n` +
    `Return ONLY ONE best guess object (NOT an array). If multiple are possible, choose the single most likely and reduce confidence.`;

  const userText =
    `Extract card identity fields from the provided images.\n` +
    `Focus on FRONT for name, set, collector number / set code, variant (foil/holo/reverse/etched/1st edition), language, and edition markers.\n` +
    `Use BACK only for game confirmation and authenticity cues.\n\n` +
    `Return ONLY JSON with:\n` +
    `{\n` +
    `  "game": "pokemon"|"mtg"|"yugioh"|"unknown",\n` +
    `  "name": string|null,\n` +
    `  "set": string|null,\n` +
    `  "setCode": string|null,\n` +
    `  "collectorNumber": string|null,\n` +
    `  "variant": string|null,\n` +
    `  "language": string|null,\n` +
    `  "confidence": number\n` +
    `}\n\n` +
    `Rules:\n` +
    `- Return ONE object only (not a list).\n` +
    `- If unsure, keep fields null and lower confidence.\n` +
    `- Never output commentary.`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemText }],
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: userText },
            { type: "input_image", image_url: frontDataUrl },
            { type: "input_image", image_url: backDataUrl },
          ],
        },
      ],
      temperature: 0.2,
      max_output_tokens: 550,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || "OpenAI identify failed");
  }

  const text = extractOutputText(data);
  if (!text) {
    debug.openaiRawText = null;
    throw new Error("Identify: model returned empty output");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    debug.openaiRawText = text.slice(0, 1200);
    throw new Error("Identify: model did not return valid JSON");
  }

  parsed = pickBestExtract(parsed);
  parsed.confidence = clamp(Number(parsed.confidence || 0), 0, 1);
  parsed.game = (parsed.game || "unknown").toLowerCase();
  if (!["pokemon", "mtg", "yugioh", "unknown"].includes(parsed.game)) parsed.game = "unknown";

  return parsed;
}

/** ------------------------------
 * Resolvers
 * ------------------------------ */

async function resolveMTG(extracted, debug) {
  const name = extracted?.name ? String(extracted.name).trim() : "";
  if (!name) return [];

  const setCode = extracted?.setCode ? String(extracted.setCode).trim() : null;
  const collectorNumber = extracted?.collectorNumber ? String(extracted.collectorNumber).trim() : null;

  const parts = [`!"${name.replace(/"/g, "")}"`];
  if (setCode) parts.push(`set:${setCode}`);
  if (collectorNumber) parts.push(`number:${collectorNumber}`);

  const q = parts.join(" ").trim();
  const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released`;

  debug.mtg = debug.mtg || {};
  debug.mtg.query = q;

  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  debug.mtg.http = r.status;
  debug.mtg.count = Array.isArray(j?.data) ? j.data.length : 0;

  if (!r.ok || !j?.data) return [];

  return j.data.slice(0, 8).map((card) => ({
    game: "mtg",
    name: card.name,
    displayName: card.name,
    set: card.set_name,
    setCode: card.set,
    collectorNumber: String(card.collector_number || ""),
    variant: card.foil ? "foil-available" : "nonfoil",
    language: card.lang || "en",
    canonical: { provider: "scryfall", id: card.id, scryfall_uri: card.scryfall_uri },
    confidence: 0.67,
  }));
}

async function resolveYugioh(extracted, debug) {
  const name = extracted?.name ? String(extracted.name).trim() : "";
  const setCode = extracted?.setCode ? String(extracted.setCode).trim() : null;
  if (!name && !setCode) return [];

  const query = name || setCode;
  const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(query)}`;

  debug.yugioh = debug.yugioh || {};
  debug.yugioh.query = query;

  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  debug.yugioh.http = r.status;
  debug.yugioh.count = Array.isArray(j?.data) ? j.data.length : 0;

  if (!r.ok || !j?.data) return [];

  const candidates = [];
  for (const c of j.data.slice(0, 8)) {
    let bestSet = null;
    if (Array.isArray(c.card_sets) && c.card_sets.length) {
      if (setCode) {
        bestSet =
          c.card_sets.find((s) => (s.set_code || "").toUpperCase() === String(setCode).toUpperCase()) ||
          c.card_sets[0];
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
      canonical: { provider: "ygoprodeck", id: String(c.id), ygo_url: c.ygoprodeck_url },
      confidence: 0.64,
    });
  }
  return candidates;
}

// Robust Pokemon resolver (works without key, better with POKETCG_API_KEY)
async function resolvePokemon(extracted, debug) {
  const apiKey = process.env.POKETCG_API_KEY; // optional
  const headers = apiKey ? { "X-Api-Key": apiKey } : {};

  const name = extracted?.name ? String(extracted.name).trim() : "";
  if (!name) return [];

  let num = normalizeCollectorNumber(extracted?.collectorNumber);
  if (num && num.includes("/")) num = num.split("/")[0].trim();
  if (!num) num = null;

  const setName = extracted?.set ? String(extracted.set).trim() : null;

  debug.pokemon = debug.pokemon || {};
  debug.pokemon.apiKeyPresent = !!apiKey;
  debug.pokemon.queries = debug.pokemon.queries || [];

  async function pokeFetch(q) {
    const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=250`;
    const r = await fetch(url, { headers });
    const j = await r.json().catch(() => ({}));
    const count = Array.isArray(j?.data) ? j.data.length : 0;
    debug.pokemon.queries.push({ q, http: r.status, count });
    if (!r.ok) return { ok: false, data: [], err: j?.error?.message || j?.message || "PokemonTCG error" };
    return { ok: true, data: j.data || [], err: null };
  }

  const safeName = name.replace(/"/g, "");
  const queries = [`name:"${safeName}"`, `name:${safeName}`, `name:${safeName.split(" ")[0]}`];

  let data = [];
  for (const q of queries) {
    const res = await pokeFetch(q);
    if (res.ok && res.data.length) {
      data = res.data;
      break;
    }
    if (!res.ok && res.err) debug.pokemon.lastError = res.err;
  }
  if (!data.length) return [];

  function scoreCard(c) {
    let s = 0;
    const cNum = String(c.number || "").trim();
    const cSet = String(c.set?.name || "");
    if (num && cNum === String(num)) s += 10;
    if (setName && cSet.toLowerCase().includes(setName.toLowerCase())) s += 3;
    if ((cSet || "").length) s += 1;
    return s;
  }

  const ranked = [...data].sort((a, b) => scoreCard(b) - scoreCard(a));

  let picked = ranked;
  if (num) {
    const exactNum = ranked.filter((c) => String(c.number || "").trim() === String(num));
    if (exactNum.length) picked = exactNum;
  }

  return picked.slice(0, 8).map((c) => ({
    game: "pokemon",
    name: c.name,
    displayName: c.name,
    set: c.set?.name || null,
    setCode: c.set?.ptcgoCode || c.set?.id || null,
    collectorNumber: String(c.number || ""),
    variant: c.rarity || null,
    language: "en",
    canonical: { provider: "pokemontcg.io", id: c.id, image: c.images?.large || c.images?.small || null },
    confidence: num && String(c.number || "").trim() === String(num) ? 0.9 : 0.67,
  }));
}

function boostByMatch(extracted, cand) {
  let score = cand.confidence || 0.5;

  const exSetCode = extracted?.setCode ? String(extracted.setCode).toLowerCase() : null;
  const exSet = extracted?.set ? String(extracted.set).toLowerCase() : null;
  const exNum = extracted?.collectorNumber ? String(normalizeCollectorNumber(extracted.collectorNumber)).toLowerCase() : null;
  const exVar = extracted?.variant ? String(extracted.variant).toLowerCase() : null;

  const cSetCode = cand?.setCode ? String(cand.setCode).toLowerCase() : null;
  const cSet = cand?.set ? String(cand.set).toLowerCase() : null;
  const cNum = cand?.collectorNumber ? String(normalizeCollectorNumber(cand.collectorNumber)).toLowerCase() : null;
  const cVar = cand?.variant ? String(cand.variant).toLowerCase() : null;

  if (exSetCode && cSetCode && exSetCode === cSetCode) score += 0.18;
  if (exNum && cNum && exNum === cNum) score += 0.18;
  if (exSet && cSet && cSet.includes(exSet)) score += 0.10;
  if (exVar && cVar && cVar.includes(exVar)) score += 0.06;

  return clamp(score, 0, 0.99);
}

/** ------------------------------
 * Handler
 * ------------------------------ */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const { frontDataUrl, backDataUrl } = await readBody(req);
    if (!frontDataUrl || !backDataUrl) {
      return json(res, 400, { error: "Missing frontDataUrl/backDataUrl" });
    }

    const debug = {
      normalizedCollectorNumber: null,
      usedSetName: null,
      pokemon: { queries: [] },
      mtg: {},
      yugioh: {},
      openaiRawText: null,
    };

    const extracted = await openaiVisionExtract({ frontDataUrl, backDataUrl }, debug);

    extracted.collectorNumber = normalizeCollectorNumber(extracted.collectorNumber);
    debug.normalizedCollectorNumber = extracted.collectorNumber || null;
    debug.usedSetName = extracted.set || null;

    let candidates = [];
    const game = extracted.game;

    if (game === "mtg") candidates = await resolveMTG(extracted, debug);
    else if (game === "yugioh") candidates = await resolveYugioh(extracted, debug);
    else if (game === "pokemon") candidates = await resolvePokemon(extracted, debug);
    else {
      const [m, y, p] = await Promise.all([
        resolveMTG(extracted, debug),
        resolveYugioh(extracted, debug),
        resolvePokemon(extracted, debug),
      ]);
      candidates = [...m, ...y, ...p];
    }

    candidates = candidates
      .map((c) => ({ ...c, confidence: boostByMatch(extracted, c) }))
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

    return json(res, 200, { extracted, candidates: candidates.slice(0, 6), debug });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e?.message || "Identify failed" });
  }
}