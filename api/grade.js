// api/grade.js
// Vercel Serverless Function (Node)
// Expects JSON: { frontDataUrl: "data:image/..;base64,...", backDataUrl: "data:image/..;base64,...", strict: boolean }
// Returns JSON: { overall, label, subgrades, notes, confidence, issues }

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Vercel usually parses JSON automatically, but handle raw body just in case.
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
      return res.status(400).json({ error: "Missing frontDataUrl or backDataUrl" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    }

    // Pick a vision-capable model. This is a safe default from OpenAI examples.
    // You can swap to a stronger model later.
    const model = "gpt-4.1-mini"; // vision example model :contentReference[oaicite:2]{index=2}

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
        notes: {
          type: "array",
          items: { type: "string" },
          maxItems: 10
        },
        issues: {
          type: "array",
          items: { type: "string" },
          maxItems: 12
        }
      },
      required: ["overall", "label", "confidence", "subgrades", "notes", "issues"]
    };

    const prompt = `
You are grd.'s grading assistant. Evaluate a trading card from TWO images (front and back).

Return a grading estimate with:
- Overall grade 1.0–10.0 (one decimal is fine)
- Subgrades (centering, corners, edges, surface) 1.0–10.0
- A short label (e.g. "Gem Mint", "Mint", "Near Mint", "Excellent", "Good")
- confidence 0.0–1.0
- notes: short, user-friendly guidance
- issues: specific observed issues (e.g. "top border thicker", "corner whitening", "surface scratches", "print line", "edge chipping", "glare prevents certainty")

Be conservative: if glare/blur/cropping prevents inspection, lower confidence and mention it.

Strict mode: if strict=true, grade slightly harsher (esp. corners/edges/surface).
`.trim();

    const payload = {
      model,
      store: false, // don’t store responses (recommended for privacy) :contentReference[oaicite:3]{index=3}
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_text", text: `strict=${!!strict}` },
            { type: "input_text", text: "Image 1: FRONT" },
            { type: "input_image", image_url: frontDataUrl, detail: "high" },
            { type: "input_text", text: "Image 2: BACK" },
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
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const errText = await r.text();
      return res.status(500).json({ error: "OpenAI request failed", detail: errText });
    }

    const data = await r.json();

    // Responses API: structured output will be in output_text in SDKs,
    // but via raw HTTP, we can still parse from `output_text` if present, else search output.
    const outputText =
      data.output_text ||
      (Array.isArray(data.output)
        ? data.output
            .flatMap((o) => o.content || [])
            .filter((c) => c.type === "output_text" && typeof c.text === "string")
            .map((c) => c.text)
            .join("\n")
        : "");

    const json = JSON.parse(outputText);
    return res.status(200).json(json);
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e) });
  }
};
