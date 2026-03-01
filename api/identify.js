// /api/identify.js  (FAST-FIRST PIPELINE)
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

function nowMs() {
  return Date.now();
}

function normalizeCollectorNumber(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // "11/108" -> "11"
  if (s.includes("/")) return s.split("/")[0].trim();
  return s;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonWithRetries(url, opts, dbg, retries = 1, timeoutMs = 8000) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetchWithTimeout(url, opts, timeoutMs);
      const j = await r.json().catch(() => ({}));
      dbg.http = r.status;
      dbg.ok = r.ok;
      dbg.error = r.ok ? null : (j?.error?.message || j?.message || j?.error || `HTTP ${r.status}`);
      return { r, j };
    } catch (e) {
      lastErr = e;
      dbg.http = "FETCH_ERR";
      dbg.ok = false;
      dbg.error = String(e?.message || e);
      if (i < retries) await sleep(180 + 220 * i);
    }
  }
  throw lastErr || new Error("Fetch failed");
}

function extractOutputText(respJson) {
  // Responses API: output -> content[] with type "output_text"
  const out = Array.isArray(respJson?.output) ? respJson.output : [];
  const chunks = [];
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") chunks.push(c.text);
    }
  }
  return chunks.join("\n").trim();
}

// ----------------------------
// OpenAI: micro extract (FAST)
// ----------------------------
async function openaiMicroExtract(frontDataUrl, debug) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");

  const t0 = nowMs();

  // Keep it tiny: front-only, minimal fields, low tokens.
  const systemText =
    "You extract trading card identity fast. Return ONLY valid JSON. No markdown, no commentary.";

  const userText =
    `From the FRONT image only, extract best guess:\n` +
    `{\n` +
    `  "game": "pokemon"|"mtg"|"yugioh"|"unknown",\n` +
    `  "name": string|null,\n` +
    `  "set": string|null,\n` +
    `  "setCode": string|null,\n` +
    `  "collectorNumber": string|null,\n` +
    `  "variant": string|null,\n` +
    `  "language": string|null,\n` +
    `  "confidence": number\n` +
    `}\n` +
    `Rules:\n` +
    `- Keep set/setCode null if not clearly visible.\n` +
    `- collectorNumber: if like "11/108", return "11/108".\n` +
    `- confidence 0..1.\n` +
    `Return ONE object ONLY.`;

  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: [{ type: "input_text", text: systemText }] },
          {
            role: "user",
            content: [
              { type: "input_text", text: userText },
              { type: "input_image", image_url: frontDataUrl },
            ],
          },
        ],
        temperature: 0.1,
        max_output_tokens: 220,
      }),
    },
    12000
  );

  const data = await resp.json().catch(() => ({}));
  debug.openaiMicro = debug.openaiMicro || {};
  debug.openaiMicro.http = resp.status;
  debug.openaiMicro.ms = nowMs() - t0;

  if (!resp.ok) throw new Error(data?.error?.message || "OpenAI micro extract failed");

  const text = extractOutputText(data);
  debug.openaiMicro.rawText = text ? text.slice(0, 500) : null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("OpenAI micro extract: invalid JSON");
  }

  // sanitize
  parsed.game = String(parsed.game || "unknown").toLowerCase();
  if (!["pokemon", "mtg", "yugioh", "unknown"].includes(parsed.game)) parsed.game = "unknown";
  parsed.confidence = clamp(Number(parsed.confidence || 0), 0, 1);
  parsed.name = parsed.name ? String(parsed.name).trim() : null;
  parsed.set = parsed.set ? String(parsed.set).trim() : null;
  parsed.setCode = parsed.setCode ? String(parsed.setCode).trim() : null;
  parsed.collectorNumber = parsed.collectorNumber ? String(parsed.collectorNumber).trim() : null;
  parsed.variant = parsed.variant ? String(parsed.variant).trim() : null;
  parsed.language = parsed.language ? String(parsed.language).trim() : null;

  return parsed;
}

// ----------------------------
// OpenAI: fallback (SLOWER)
// ----------------------------
async function openaiFallbackExtract(frontDataUrl, backDataUrl, debug) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");

  const t0 = nowMs();

  const systemText =
    "You are a trading card identification assistant for Pokemon, MTG, Yu-Gi-Oh. Return ONLY valid JSON (no markdown).";

  const userText =
    `Use FRONT+BACK to improve set/setCode/collectorNumber/variant.\n` +
    `Return ONLY:\n` +
    `{\n` +
    `  "game": "pokemon"|"mtg"|"yugioh"|"unknown",\n` +
    `  "name": string|null,\n` +
    `  "set": string|null,\n` +
    `  "setCode": string|null,\n` +
    `  "collectorNumber": string|null,\n` +
    `  "variant": string|null,\n` +
    `  "language": string|null,\n` +
    `  "confidence": number\n` +
    `}`;

  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: [{ type: "input_text", text: systemText }] },
          {
            role: "user",
            content: [
              { type: "input_text", text: userText },
              { type: "input_image", image_url: frontDataUrl },
              { type: "input_image", image_url: backDataUrl },
            ],
          },
        ],
        temperature: 0.15,
        max_output_tokens: 320,
      }),
    },
    14000
  );

  const data = await resp.json().catch(() => ({}));
  debug.openaiFallback = debug.openaiFallback || {};
  debug.openaiFallback.http = resp.status;
  debug.openaiFallback.ms = nowMs() - t0;

  if (!resp.ok) throw new Error(data?.error?.message || "OpenAI fallback extract failed");

  const text = extractOutputText(data);
  debug.openaiFallback.rawText = text ? text.slice(0, 600) : null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("OpenAI fallback extract: invalid JSON");
  }

  // sanitize
  parsed.game = String(parsed.game || "unknown").toLowerCase();
  if (!["pokemon", "mtg", "yugioh", "unknown"].includes(parsed.game)) parsed.game = "unknown";
  parsed.confidence = clamp(Number(parsed.confidence || 0), 0, 1);
  parsed.name = parsed.name ? String(parsed.name).trim() : null;
  parsed.set = parsed.set ? String(parsed.set).trim() : null;
  parsed.setCode = parsed.setCode ? String(parsed.setCode).trim() : null;
  parsed.collectorNumber = parsed.collectorNumber ? String(parsed.collectorNumber).trim() : null;
  parsed.variant = parsed.variant ? String(parsed.variant).trim() : null;
  parsed.language = parsed.language ? String(parsed.language).trim() : null;

  return parsed;
}

// ----------------------------
// Resolvers (FAST, deterministic)
// ----------------------------

// Pokemon: TCGdex first (no key, quick), then PokémonTCG.io (optional key)
async function resolvePokemon(extracted, debug) {
  const name = extracted?.name ? String(extracted.name).trim() : "";
  if (!name) return [];

  const num = normalizeCollectorNumber(extracted?.collectorNumber);
  const setName = extracted?.set ? String(extracted.set).trim() : null;

  debug.pokemon = debug.pokemon || { tcgdex: [], pokemontcg: [] };

  // ---- 1) TCGdex name search ----
  // API is fast + no key. Returns array.
  // We avoid huge pages and keep it tight.
  const tcgdexUrl =
    `https://api.tcgdex.net/v2/en/cards?` +
    new URLSearchParams({
      name: `eq:${name}`,
      "pagination:page": "1",
      "pagination:itemsPerPage": "60",
    }).toString();

  const tcgDbg = { url: tcgdexUrl, http: null, count: 0, ms: null, error: null };
  debug.pokemon.tcgdex.push(tcgDbg);

  let tcgList = [];
  {
    const t0 = nowMs();
    try {
      const r = await fetchWithTimeout(tcgdexUrl, {}, 6500);
      const j = await r.json().catch(() => ([]));
      tcgDbg.http = r.status;
      tcgDbg.ms = nowMs() - t0;
      tcgDbg.count = Array.isArray(j) ? j.length : 0;
      if (r.ok && Array.isArray(j)) tcgList = j;
    } catch (e) {
      tcgDbg.http = "FETCH_ERR";
      tcgDbg.error = String(e?.message || e);
      tcgDbg.ms = nowMs() - t0;
    }
  }

  // Narrow by number if we have it
  if (tcgList.length && num) {
    const exact = tcgList.filter((c) => String(c.localId || "").trim() === String(num));
    if (exact.length) tcgList = exact;
  }

  // Pull details for top few for set info + image
  const details = [];
  for (const c of tcgList.slice(0, 5)) {
    const url = `https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(c.id)}`;
    const dDbg = { id: c.id, http: null, ms: null, error: null };
    debug.pokemon.tcgdex.push(dDbg);

    const t0 = nowMs();
    try {
      const r = await fetchWithTimeout(url, {}, 6500);
      const j = await r.json().catch(() => ({}));
      dDbg.http = r.status;
      dDbg.ms = nowMs() - t0;
      if (r.ok && j?.id) details.push(j);
    } catch (e) {
      dDbg.http = "FETCH_ERR";
      dDbg.ms = nowMs() - t0;
      dDbg.error = String(e?.message || e);
    }
  }

  // Score + map TCGdex results into candidates
  const tcgdexCandidates = details.map((c) => {
    const cNum = c.localId ? String(c.localId).trim() : "";
    const cSet = c.set?.name ? String(c.set.name) : "";
    let conf = 0.62;
    if (num && cNum === String(num)) conf = 0.86;
    else if (setName && cSet.toLowerCase().includes(setName.toLowerCase())) conf = 0.72;

    return {
      game: "pokemon",
      name: c.name || name,
      displayName: c.name || name,
      set: c.set?.name || null,
      setCode: c.set?.id || null,
      collectorNumber: c.localId ? String(c.localId) : (num ? String(num) : ""),
      variant: c.rarity || null,
      language: "en",
      canonical: {
        provider: "tcgdex",
        id: c.id,
        image: c.image ? `${c.image}/high` : null,
      },
      confidence: conf,
    };
  });

  if (tcgdexCandidates.length) return tcgdexCandidates.slice(0, 8);

  // ---- 2) PokémonTCG.io (optional key) ----
  // Only try a single tight query to keep it fast.
  const apiKey = process.env.POKETCG_API_KEY;
  const headers = apiKey ? { "X-Api-Key": apiKey } : {};

  const qParts = [`name:"${name.replace(/"/g, "")}"`];
  if (num) qParts.push(`number:"${String(num).replace(/"/g, "")}"`);
  if (setName) qParts.push(`set.name:"${setName.replace(/"/g, "")}"`);
  const q = qParts.join(" ");

  const pokeUrl =
    `https://api.pokemontcg.io/v2/cards?` +
    new URLSearchParams({
      q,
      pageSize: "35",
      select: "id,name,number,rarity,set.name,set.id,set.ptcgoCode,images.small,images.large",
    }).toString();

  const pDbg = { url: pokeUrl, http: null, count: 0, ms: null, error: null, apiKeyPresent: !!apiKey };
  debug.pokemon.pokemontcg.push(pDbg);

  const t0 = nowMs();
  try {
    const { r, j } = await fetchJsonWithRetries(pokeUrl, { headers }, pDbg, 1, 7000);
    pDbg.ms = nowMs() - t0;

    const data = Array.isArray(j?.data) ? j.data : [];
    pDbg.count = data.length;

    if (!r.ok || !data.length) return [];

    return data.slice(0, 8).map((c) => ({
      game: "pokemon",
      name: c.name,
      displayName: c.name,
      set: c.set?.name || null,
      setCode: c.set?.ptcgoCode || c.set?.id || null,
      collectorNumber: String(c.number || ""),
      variant: c.rarity || null,
      language: "en",
      canonical: { provider: "pokemontcg.io", id: c.id, image: c.images?.large || c.images?.small || null },
      confidence: 0.68,
    }));
  } catch (e) {
    pDbg.ms = nowMs() - t0;
    pDbg.error = String(e?.message || e);
    return [];
  }
}

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

  const t0 = nowMs();
  try {
    const r = await fetchWithTimeout(url, {}, 6500);
    const j = await r.json().catch(() => ({}));
    debug.mtg.http = r.status;
    debug.mtg.ms = nowMs() - t0;
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
      confidence: 0.70,
    }));
  } catch (e) {
    debug.mtg.http = "FETCH_ERR";
    debug.mtg.error = String(e?.message || e);
    debug.mtg.ms = nowMs() - t0;
    return [];
  }
}

async function resolveYugioh(extracted, debug) {
  const name = extracted?.name ? String(extracted.name).trim() : "";
  const setCode = extracted?.setCode ? String(extracted.setCode).trim() : null;
  if (!name && !setCode) return [];

  const query = name || setCode;
  const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(query)}`;

  debug.yugioh = debug.yugioh || {};
  debug.yugioh.query = query;

  const t0 = nowMs();
  try {
    const r = await fetchWithTimeout(url, {}, 6500);
    const j = await r.json().catch(() => ({}));
    debug.yugioh.http = r.status;
    debug.yugioh.ms = nowMs() - t0;
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
        confidence: 0.66,
      });
    }
    return candidates;
  } catch (e) {
    debug.yugioh.http = "FETCH_ERR";
    debug.yugioh.error = String(e?.message || e);
    debug.yugioh.ms = nowMs() - t0;
    return [];
  }
}

function boostByMatch(extracted, cand) {
  let score = cand.confidence || 0.55;

  const exSetCode = extracted?.setCode ? String(extracted.setCode).toLowerCase() : null;
  const exSet = extracted?.set ? String(extracted.set).toLowerCase() : null;
  const exNum = extracted?.collectorNumber
    ? String(normalizeCollectorNumber(extracted.collectorNumber)).toLowerCase()
    : null;
  const exVar = extracted?.variant ? String(extracted.variant).toLowerCase() : null;

  const cSetCode = cand?.setCode ? String(cand.setCode).toLowerCase() : null;
  const cSet = cand?.set ? String(cand.set).toLowerCase() : null;
  const cNum = cand?.collectorNumber
    ? String(normalizeCollectorNumber(cand.collectorNumber)).toLowerCase()
    : null;
  const cVar = cand?.variant ? String(cand.variant).toLowerCase() : null;

  if (exSetCode && cSetCode && exSetCode === cSetCode) score += 0.18;
  if (exNum && cNum && exNum === cNum) score += 0.20;
  if (exSet && cSet && cSet.includes(exSet)) score += 0.10;
  if (exVar && cVar && cVar.includes(exVar)) score += 0.06;

  return clamp(score, 0, 0.99);
}

// Helper: run resolvers in parallel and return merged candidates quickly
async function runResolvers(extracted, debug) {
  const game = extracted.game;

  if (game === "pokemon") return await resolvePokemon(extracted, debug);
  if (game === "mtg") return await resolveMTG(extracted, debug);
  if (game === "yugioh") return await resolveYugioh(extracted, debug);

  // unknown -> run all three concurrently
  const [p, m, y] = await Promise.all([
    resolvePokemon(extracted, debug),
    resolveMTG(extracted, debug),
    resolveYugioh(extracted, debug),
  ]);

  return [...p, ...m, ...y];
}

// ----------------------------
// HANDLER
// ----------------------------
export default async function handler(req, res) {
  const debug = {
    timings: {},
    openaiMicro: null,
    openaiFallback: null,
    pokemon: { tcgdex: [], pokemontcg: [] },
    mtg: {},
    yugioh: {},
  };

  const tAll = nowMs();

  try {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const { frontDataUrl, backDataUrl } = await readBody(req);
    if (!frontDataUrl || !backDataUrl) return json(res, 400, { error: "Missing frontDataUrl/backDataUrl" });

    // 1) FAST: OpenAI micro extract (front-only)
    const t0 = nowMs();
    let extracted = await openaiMicroExtract(frontDataUrl, debug);
    debug.timings.microExtractMs = nowMs() - t0;

    extracted.collectorNumber = normalizeCollectorNumber(extracted.collectorNumber);

    // 2) FAST: Resolve using APIs
    const t1 = nowMs();
    let candidates = await runResolvers(extracted, debug);
    debug.timings.resolversMs = nowMs() - t1;

    // If we got candidates, return immediately (FAST PATH)
    if (candidates.length) {
      candidates = candidates
        .map((c) => ({ ...c, confidence: boostByMatch(extracted, c) }))
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .slice(0, 6);

      debug.timings.totalMs = nowMs() - tAll;

      return json(res, 200, {
        extracted,
        candidates,
        debug,
      });
    }

    // 3) SLOWER FALLBACK: Only if no candidates and we have back image
    const t2 = nowMs();
    const refined = await openaiFallbackExtract(frontDataUrl, backDataUrl, debug);
    debug.timings.fallbackExtractMs = nowMs() - t2;

    // Merge refined over extracted (don’t wipe fields that were already non-null)
    extracted = {
      ...extracted,
      ...Object.fromEntries(Object.entries(refined).filter(([, v]) => v !== null && v !== "")),
    };
    extracted.collectorNumber = normalizeCollectorNumber(extracted.collectorNumber);

    const t3 = nowMs();
    candidates = await runResolvers(extracted, debug);
    debug.timings.resolversAfterFallbackMs = nowMs() - t3;

    candidates = candidates
      .map((c) => ({ ...c, confidence: boostByMatch(extracted, c) }))
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 6);

    debug.timings.totalMs = nowMs() - tAll;

    return json(res, 200, {
      extracted,
      candidates,
      debug,
      note: candidates.length ? null : "No candidates found. Try a closer front shot (name + number).",
    });
  } catch (e) {
    debug.error = e?.message || "Identify failed";
    debug.timings.totalMs = nowMs() - tAll;
    return json(res, 500, { error: debug.error, debug });
  }
}