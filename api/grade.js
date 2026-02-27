// api/grade.js (Vercel Serverless Function - Node)
// POST JSON: { frontDataUrl, backDataUrl, strict }
// Returns: grading JSON or { error, detail }

module.exports = async function handler(req, res) {
  const fail = (code, error, detail) => res.status(code).json({ error, detail });

  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return fail(405, "Method not allowed", "Use POST with JSON body.");
    }

    // Parse body robustly (Vercel may already parse JSON into req.body)
    let body = req.body;

    if (!body || typeof body === "string") {
      const raw =
        typeof body === "string"
          ? body
          : await new Promise((resolve, reject) => {
              let data = "";
              req.on("data", (chunk) => (data += chunk));
              req.on("end", () => resolve(data));
              req.on("error", reject);
            });

      body = raw ? JSON.parse(raw) : {};
    }

    const { frontDataUrl, backDataUrl, strict } = body || {};

    if (!frontDataUrl || !backDataUrl) {
      return fail(400, "Missing images", "Provide frontDataUrl and backDataUrl (data URLs).");
    }

    // Basic sanity check on data URLs
    if (typeof frontDataUrl !== "string" || typeof backDataUrl !== "string") {
      return fail(400, "Invalid payload", "frontDataUrl/backDataUrl must be strings.");
    }
    if (!frontDataUrl.startsWith("data:image/") || !backDataUrl.startsWith("data:image/")) {
      return fail(400, "Invalid image format", "Images must be data URLs like data:image/jpeg;base64,....");
    }

    if (!process.env.OPENAI_API_KEY) {
      return fail(500, "OPENAI_API_KEY is not set", "Add it in Vercel → Settings → Environment Variables and redeploy.");
    }

    // Model: if your account doesn’t have access to a specific model, OpenAI will return a clear error.
    const model = "gpt-4.1-mini";

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        overall: { type: "number", minimum: 1, maximum: 10 },
        label: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        subgrades: {
          type: "object",
          additionalProperties: false,
          properties: {
            centering: { type: "number", minimum: 1, maximum: 10 },
            corners: { type: "number", minimum: 1, maximum: 10 },
            edges: { type: "number", minimum: 1, maximum: 10 },
            surface: { type: "number", minimum: 1, maximum: 10 }
          },
          required: ["centering", "corners", "edges", "surface"]
        },
        notes: { type: "array", items: { type: "string" }, maxItems: 10 },
        issues: { type: "array", items: { type: "string" }, maxItems: 12 }
      },
      required: ["overall", "label", "confidence", "subgrades", "notes", "issues"]
    };

    const instruction = `
You are grd.'s grading assistant. Evaluate a trading card from TWO images (front and back).

Return:
- overall grade 1.0–10.0
- subgrades: centering/corners/edges/surface 1.0–10.0
- label (Gem Mint / Mint / Near Mint / Excellent / Good)
- confidence 0.0–1.0
- notes: short, user-friendly guidance
- issues: specific observed issues

Be conservative: if glare/blur/cropping prevents inspection, lower confidence and mention it.
If strict=true, grade slightly harsher.
`.trim();

    const payload = {
      model,
      store: false,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: instruction },
            { type: "input_text", text: `strict=${!!strict}` },
            { type: "input_text", text: "FRONT" },
            { type: "input_image", image_url: frontDataUrl, detail: "high" },
            { type: "input_text", text: "BACK" },
            { type: "input_image", image_url: backDataUrl, detail: "high" }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "card_grade",
          strict: true,
          schema
        }
      }
    };

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const rawText = await r.text();

    if (!r.ok) {
      // Return OpenAI error payload to client for debugging
      return fail(500, "OpenAI request failed", rawText.slice(0, 2000));
    }

    const data = JSON.parse(rawText);

    // Extract the model output text safely
    let out = data.output_text;

    if (!out && Array.isArray(data.output)) {
      const texts = [];
      for (const item of data.output) {
        const content = item && item.content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
          if (c?.type === "output_text" && typeof c.text === "string") texts.push(c.text);
          if (c?.type === "output_json" && typeof c.json === "object") {
            // Some responses may include structured JSON directly
            return res.status(200).json(c.json);
          }
        }
      }
      out = texts.join("\n");
    }

    if (!out) {
      return fail(500, "No output from model", JSON.stringify(data).slice(0, 2000));
    }

    let json;
    try {
      json = JSON.parse(out);
    } catch (e) {
      return fail(500, "Failed to parse model JSON", out.slice(0, 2000));
    }

    return res.status(200).json(json);
  } catch (e) {
    return fail(500, "Server error", String(e));
  }
};
