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

function normalizeGame(game) {
  const g = String(game || "").toLowerCase().trim();
  if (["pokemon", "pokémon"].includes(g)) return "pokemon";
  if (["mtg", "magic", "magic: the gathering"].includes(g)) return "mtg";
  if (["yugioh", "yu-gi-oh", "yu gi oh"].includes(g)) return "yugioh";
  return "unknown";
}

function justtcgGameParam(game) {
  // JustTCG expects these (commonly): pokemon | mtg | yugioh
  const g = normalizeGame(game);
  if (g === "mtg") return "mtg";
  if (g === "yugioh") return "yugioh";
  if (g === "pokemon") return "pokemon";
  return null;
}

function normalizeCollectorNumber(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.includes("/")) return s.split("/")[0].trim(); // "11/108" -> "11"
  return s;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 6500) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

/**
 * ------------------------------
 * JustTCG search -> candidates
 * ------------------------------
 * Requires env: JUSTTCG_API_KEY
 *
 * We keep this deliberately permissive:
 * - only q + game + limit
 * - no condition/printing filters (those caused 400s)
 */
async function justtcgSearchCandidates({ q, game }, debug) {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) {
    debug.justtcg = { ok: false, error: "Missing JUSTTCG_API_KEY" };
    return [];
  }

  const params = new URLSearchParams();
  params.set("q", q);
  const g = justtcgGameParam(game);
  if (g) params.set("game", g);
  params.set("limit", "25");
  params.set("offset", "0");

  // This is the endpoint you’ve been using in debug:
  // https://api.justtcg.com/v1/cards?q=...&game=...&limit=...&offset=...
  const url = `https://api.justtcg.com/v1/cards?${params.toString()}`;

  debug.justtcg = { url, q, game: g || null, http: null, count: 0, picked: null, error: null };

  const r = await fetchWithTimeout(
    url,
    {
      headers: {
        // IMPORTANT: JustTCG auth is typically x-api-key (not Bearer)
        "x-api-key": apiKey,
        Accept: "application/json",
      },
    },
    6500
  );

  debug.justtcg.http = r.status;

  const j = await r.json().catch(() => ({}));

  // Try a few common shapes
  const list =
    (Array.isArray(j?.data) && j.data) ||
    (Array.isArray(j?.results) && j.results) ||
    (Array.isArray(j?.cards) && j.cards) ||
    (Array.isArray(j) && j) ||
    [];

  debug.justtcg.count = list.length;

  if (!r.ok) {
    debug.justtcg.error = j?.error?.message || j?.message || j?.error || `HTTP ${r.status}`;
    return [];
  }

  // Map results into your candidate shape (keep stable fields)
  const candidates = list.slice(0, 8).map((c) => {
    // Defensive extraction (JustTCG fields can vary by plan)
    const name = c?.name || c?.card_name || c?.title || null;
    const set = c?.set?.name || c?.set_name || c?.set || null;
    const number =
      c?.number ||
      c?.collector_number ||
      c?.collectorNumber ||
      c?.card_number ||
      null;

    // Prefer a stable id if provided
    const id = c?.id || c?.card_id || c?._id || null;

    const image =
      c?.image?.large ||
      c?.image?.small ||
      c?.images?.large ||
      c?.images?.small ||
      c?.image ||
      null;

    return {
      game: g || normalizeGame(game),
      name: name,
      displayName: name,
      set: set,
      setCode: c?.set?.code || c?.set_code || null,
      collectorNumber: number ? String(number) : null,
      variant: c?.variant || c?.rarity || c?.finish || null,
      language: c?.language || "en",
      canonical: {
        provider: "justtcg",
        id,
        raw: c, // optional: can remove if payload too large
        image,
      },
      confidence: 0.65, // base; UI will confirm
    };
  });

  // small confidence boost if query seems precise
  if (candidates.length) debug.justtcg.picked = candidates[0]?.canonical?.id || null;

  return candidates;
}

/**
 * ------------------------------
 * OPTIONAL AI EXTRACT (slow)
 * ------------------------------
 * Disabled by default. Enable by setting env:
 *   IDENTIFY_USE_OPENAI=true
 */
function extractOutputText(respJson) {
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

async function openaiVisionExtract({ frontDataUrl, backDataUrl }, debug) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");

  const systemText =
    `You are a trading card identification assistant for: Pokemon, Magic: The Gathering, and Yu-Gi-Oh.\n` +
    `Return ONLY valid JSON. No markdown. One object only.`;

  const userText =
    `Extract: game, name, set, setCode, collectorNumber, variant, language, confidence (0..1).\n` +
    `Return ONLY JSON object. If unsure, keep fields null and lower confidence.`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
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
      temperature: 0.2,
      max_output_tokens: 450,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || "OpenAI identify failed");

  const text = extractOutputText(data);
  if (!text) throw new Error("Identify: model returned empty output");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    debug.openaiRawText = text.slice(0, 1200);
    throw new Error("Identify: model did not return valid JSON");
  }

  // sanitize
  parsed.game = normalizeGame(parsed.game);
  parsed.confidence = clamp(Number(parsed.confidence || 0), 0, 1);
  parsed.collectorNumber = normalizeCollectorNumber(parsed.collectorNumber);

  return parsed;
}

/**
 * ------------------------------
 * Handler
 * ------------------------------
 */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const body = await readBody(req);

    // NEW: q + game are supported for fast identify.
    // Your UI can send:
    // { q: "Cubone Jungle 50", game: "pokemon" }
    const q = (body?.q ? String(body.q) : "").trim();
    const game = normalizeGame(body?.game);

    // Backwards compatible: accept images too (for optional AI assist)
    const frontDataUrl = body?.frontDataUrl || null;
    const backDataUrl = body?.backDataUrl || null;

    const debug = {
      mode: null,
      justtcg: null,
      openaiRawText: null,
    };

    // ---- FAST PATH: JustTCG search ----
    // If q is provided, we never call OpenAI.
    if (q) {
      debug.mode = "justtcg_search";
      const candidates = await justtcgSearchCandidates({ q, game }, debug);

      return json(res, 200, {
        extracted: {
          game: game !== "unknown" ? game : null,
          name: null,
          set: null,
          setCode: null,
          collectorNumber: null,
          variant: null,
          language: "en",
          confidence: 0,
          query: q,
        },
        candidates: candidates.slice(0, 6),
        debug,
      });
    }

    // ---- OPTIONAL: AI -> JustTCG ----
    // If you still want image-only identify, enable env IDENTIFY_USE_OPENAI=true
    const useOpenAI = String(process.env.IDENTIFY_USE_OPENAI || "").toLowerCase() === "true";
    if (!useOpenAI) {
      debug.mode = "no_query_no_openai";
      return json(res, 200, {
        extracted: {
          game: null,
          name: null,
          set: null,
          setCode: null,
          collectorNumber: null,
          variant: null,
          language: "en",
          confidence: 0,
        },
        candidates: [],
        debug,
        note: "Provide {q, game} for fast identify, or enable IDENTIFY_USE_OPENAI=true for image-only identification.",
      });
    }

    if (!frontDataUrl || !backDataUrl) {
      return json(res, 400, { error: "Missing q OR frontDataUrl/backDataUrl" });
    }

    debug.mode = "openai_then_justtcg";
    const extracted = await openaiVisionExtract({ frontDataUrl, backDataUrl }, debug);

    // Build a query for JustTCG from extracted fields
    const parts = [];
    if (extracted?.name) parts.push(extracted.name);
    if (extracted?.set) parts.push(extracted.set);
    if (extracted?.collectorNumber) parts.push(extracted.collectorNumber);
    const builtQ = parts.join(" ").trim();

    const candidates = builtQ
      ? await justtcgSearchCandidates({ q: builtQ, game: extracted.game }, debug)
      : [];

    // Boost candidates if number/name match (lightweight)
    const exNum = extracted?.collectorNumber ? String(extracted.collectorNumber) : null;
    const exSet = extracted?.set ? String(extracted.set).toLowerCase() : null;

    const boosted = candidates
      .map((c) => {
        let conf = Number(c.confidence || 0.65);
        if (exNum && c.collectorNumber && String(c.collectorNumber).includes(exNum)) conf += 0.12;
        if (exSet && c.set && String(c.set).toLowerCase().includes(exSet)) conf += 0.08;
        return { ...c, confidence: clamp(conf, 0, 0.99) };
      })
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

    return json(res, 200, {
      extracted: { ...extracted, query: builtQ || null },
      candidates: boosted.slice(0, 6),
      debug,
    });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e?.message || "Identify failed" });
  }
}