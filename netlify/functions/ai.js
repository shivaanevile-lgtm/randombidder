function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: "Server is missing ANTHROPIC_API_KEY — add it in Netlify site settings under Environment variables." }, 500);
  }

  try {
    const body = await req.json();
    const prompt = String(body.prompt || "").slice(0, 4000);
    if (!prompt) return json({ error: "Missing prompt" }, 400);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await res.json();
    if (data.error) return json({ error: data.error.message || "Anthropic API error" }, 502);

    const text = (data.content || []).map((b) => b.text || "").join("\n");
    return json({ text });
  } catch (e) {
    return json({ error: e.message || "Server error" }, 500);
  }
};

export const config = { path: "/api/ai" };
