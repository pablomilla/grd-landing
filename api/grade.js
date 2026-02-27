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

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

export default async function handler(req, res){
  try{
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const key = process.env.OPENAI_API_KEY;
    if (!key) return json(res, 500, { error: "Missing OPENAI_API_KEY" });

    const { frontDataUrl, backDataUrl, strict } = await readBody(req);
    if (!frontDataUrl || !backDataUrl) return json(res, 400, { error: "Missing frontDataUrl/backDataUrl" });

    const system = `You are a strict trading card pre-screening assistant.
You must return ONLY valid JSON. You are NOT issuing an official grade.
Produce a realistic grade distribution and issues list based on image evidence.`;

    const userText =
`Analyze the FRONT and BACK images of a trading card.
Return JSON with:
{
  "mostLikely": number,               // 1..10, round to nearest 0.5
  "range": [number, number],          // likely range, e.g. [8.5, 9.5]
  "confidence": number,               // 0..1
  "label": string,                    // e.g. "Likely 9", "Borderline 10"
  "distribution": [                   // grade distribution (sum ~1)
    {"grade": 8.5, "prob": 0.2}, {"grade": 9.0, "prob": 0.5}, {"grade": 9.5, "prob": 0.25}, {"grade": 10.0, "prob": 0.05}
  ],
  "subgrades": {"centering": number, "corners": number, "edges": number, "surface": number},
  "issues": string[],
  "notes": string[]
}

Rules:
- Use grades in increments of 0.5.
- If strict=true, be harsher on surface flaws and whitening.
- Do not claim certainty; use confidence + range.
- Keep issues factual (glare, whitening, centering off, scratches, print lines).`;

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
          {
            role:"user",
            content: [
              { type:"text", text: userText + `\n\nstrict=${!!strict}` },
              { type:"image_url", image_url: { url: frontDataUrl } },
              { type:"image_url", image_url: { url: backDataUrl } }
            ]
          }
        ],
        temperature: 0.25,
        max_output_tokens: 800
      })
    });

    const data = await resp.json().catch(()=> ({}));
    if (!resp.ok){
      return json(res, 500, { error: data?.error?.message || "OpenAI grade failed" });
    }

    const out = (data.output || []).flatMap(o => o.content || []);
    const text = out.map(c => c.text).filter(Boolean).join("\n").trim();

    let parsed;
    try{ parsed = JSON.parse(text); } catch(e){
      return json(res, 500, { error: "Grade: model did not return valid JSON" });
    }

    // sanitize
    parsed.confidence = clamp(Number(parsed.confidence || 0.5), 0, 1);
    parsed.mostLikely = clamp(Number(parsed.mostLikely || 9), 1, 10);
    if (!Array.isArray(parsed.range) || parsed.range.length !== 2){
      parsed.range = [Math.max(1, parsed.mostLikely - 0.5), Math.min(10, parsed.mostLikely + 0.5)];
    }
    parsed.range = [clamp(Number(parsed.range[0]||parsed.mostLikely-0.5),1,10), clamp(Number(parsed.range[1]||parsed.mostLikely+0.5),1,10)]
      .sort((a,b)=>a-b);

    // normalize distribution
    if (!Array.isArray(parsed.distribution) || !parsed.distribution.length){
      parsed.distribution = [
        {grade: Math.max(1, parsed.mostLikely-0.5), prob: 0.25},
        {grade: parsed.mostLikely, prob: 0.5},
        {grade: Math.min(10, parsed.mostLikely+0.5), prob: 0.25}
      ];
    }
    let sum = parsed.distribution.reduce((s,x)=> s + Number(x.prob||0), 0);
    if (sum <= 0) sum = 1;
    parsed.distribution = parsed.distribution.map(x=>({
      grade: clamp(Number(x.grade||parsed.mostLikely), 1, 10),
      prob: Number(x.prob||0)/sum
    }));

    return json(res, 200, parsed);

  } catch (e){
    console.error(e);
    return json(res, 500, { error: e.message || "Grade failed" });
  }
}