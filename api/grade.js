// /api/grade.js
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

function roundToHalf(x){
  const n = Number(x);
  if (!isFinite(n)) return null;
  return Math.round(n * 2) / 2;
}

function sanitizeReport(r){
  const out = { ...r };

  out.mostLikely = clamp(roundToHalf(out.mostLikely ?? 9) ?? 9, 1, 10);

  // range
  if (!Array.isArray(out.range) || out.range.length !== 2) {
    out.range = [clamp(out.mostLikely - 0.5, 1, 10), clamp(out.mostLikely + 0.5, 1, 10)];
  }
  out.range = [
    clamp(roundToHalf(out.range[0]) ?? out.mostLikely - 0.5, 1, 10),
    clamp(roundToHalf(out.range[1]) ?? out.mostLikely + 0.5, 1, 10),
  ].sort((a,b)=>a-b);

  out.confidence = clamp(Number(out.confidence ?? 0.5), 0, 1);
  out.label = typeof out.label === "string" ? out.label : "";

  // distribution normalize
  if (!Array.isArray(out.distribution) || !out.distribution.length) {
    out.distribution = [
      { grade: clamp(out.mostLikely - 0.5, 1, 10), prob: 0.25 },
      { grade: out.mostLikely, prob: 0.5 },
      { grade: clamp(out.mostLikely + 0.5, 1, 10), prob: 0.25 },
    ];
  }
  let sum = 0;
  out.distribution = out.distribution.map(d => {
    const grade = clamp(roundToHalf(d.grade) ?? out.mostLikely, 1, 10);
    const prob = Math.max(0, Number(d.prob ?? 0));
    sum += prob;
    return { grade, prob };
  });
  if (sum <= 0) sum = 1;
  out.distribution = out.distribution.map(d => ({ ...d, prob: d.prob / sum }));

  // subgrades
  const sg = out.subgrades || {};
  out.subgrades = {
    centering: clamp(roundToHalf(sg.centering ?? out.mostLikely) ?? out.mostLikely, 1, 10),
    corners:   clamp(roundToHalf(sg.corners   ?? out.mostLikely) ?? out.mostLikely, 1, 10),
    edges:     clamp(roundToHalf(sg.edges     ?? out.mostLikely) ?? out.mostLikely, 1, 10),
    surface:   clamp(roundToHalf(sg.surface   ?? out.mostLikely) ?? out.mostLikely, 1, 10),
  };

  out.issues = Array.isArray(out.issues) ? out.issues.map(String).slice(0, 24) : [];
  out.notes  = Array.isArray(out.notes)  ? out.notes.map(String).slice(0, 24)  : [];

  return out;
}

async function fetchWithTimeout(url, options = {}, ms = 20000){
  const ctrl = new AbortController();
  const t = setTimeout(()=> ctrl.abort(), ms);
  try{
    const r = await fetch(url, { ...options, signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res){
  try{
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const key = process.env.OPENAI_API_KEY;
    if (!key) return json(res, 500, { error: "Missing OPENAI_API_KEY" });

    const { frontDataUrl, backDataUrl, strict } = await readBody(req);
    if (!frontDataUrl || !backDataUrl) return json(res, 400, { error: "Missing frontDataUrl/backDataUrl" });

    const systemText =
`You are a strict trading card pre-screening assistant.
You are NOT issuing an official grade. Be realistic.
If strict=true, be harsher on surface flaws and whitening.`;

    const tool = {
      type: "function",
      function: {
        name: "grade_card",
        description: "Return a grading estimate report for a single card from front+back images.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["mostLikely","range","confidence","label","distribution","subgrades","issues","notes"],
          properties: {
            mostLikely: { type: "number", description: "1..10 in increments of 0.5" },
            range: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
            confidence: { type: "number", description: "0..1" },
            label: { type: "string" },
            distribution: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["grade","prob"],
                properties: {
                  grade: { type: "number" },
                  prob: { type: "number" }
                }
              }
            },
            subgrades: {
              type: "object",
              additionalProperties: false,
              required: ["centering","corners","edges","surface"],
              properties: {
                centering: { type: "number" },
                corners: { type: "number" },
                edges: { type: "number" },
                surface: { type: "number" }
              }
            },
            issues: { type: "array", items: { type: "string" } },
            notes: { type: "array", items: { type: "string" } }
          }
        }
      }
    };

    const userText =
`Analyze the FRONT and BACK images of a trading card.
Return a realistic estimate with:
- grades in 0.5 steps
- a likely range
- factual issues (whitening, corner wear, scratches, print lines, centering off, etc.)
strict=${!!strict}`;

    const resp = await fetchWithTimeout("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
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
              { type: "input_image", image_url: backDataUrl }
            ]
          }
        ],
        tools: [tool],
        tool_choice: { type: "function", function: { name: "grade_card" } },
        temperature: 0.2,
        max_output_tokens: 900
      })
    }, 25000);

    const data = await resp.json().catch(()=> ({}));
    if (!resp.ok){
      return json(res, 500, { error: data?.error?.message || "OpenAI grade failed" });
    }

    // Find the tool call arguments
    const outputs = Array.isArray(data?.output) ? data.output : [];
    let args = null;

    for (const o of outputs){
      const content = Array.isArray(o?.content) ? o.content : [];
      for (const c of content){
        // Depending on Responses API shape, tool call args may appear in a function call item.
        if (c?.type === "tool_call" && c?.name === "grade_card" && c?.arguments) {
          args = c.arguments;
        }
        // Some shapes return: {type:"tool_call", tool_name, ...}
        if (!args && c?.type === "tool_call" && (c?.tool_name === "grade_card") && c?.arguments) {
          args = c.arguments;
        }
      }
    }

    if (!args){
      // Fallback: try to locate any function/tool call in output
      for (const o of outputs){
        if (o?.type === "tool_call" && o?.name === "grade_card" && o?.arguments) args = o.arguments;
      }
    }

    if (!args) return json(res, 500, { error: "Grade: no tool output returned" });

    // arguments may already be an object or a JSON string
    let report = args;
    if (typeof args === "string"){
      try{ report = JSON.parse(args); } catch(_){ return json(res, 500, { error: "Grade: tool arguments not valid JSON" }); }
    }

    return json(res, 200, sanitizeReport(report));

  } catch (e){
    console.error(e);
    return json(res, 500, { error: e.message || "Grade failed" });
  }
}