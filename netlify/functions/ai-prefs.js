import { getStore } from "@netlify/blobs";

const KEY = "global";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export default async (req) => {
  const store = getStore("ai-prefs");

  try {
    if (req.method === "GET") {
      const data = await store.get(KEY, { type: "json" });
      return json(data || { items: {}, categories: {} });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const item = body.item ? String(body.item).slice(0, 80) : null;
      const category = body.category ? String(body.category).slice(0, 40) : null;
      const amount = Math.max(0, Math.min(20, Math.floor(Number(body.amount) || 0)));
      if (amount <= 0 || (!item && !category)) return json({ ok: true });

      const data = (await store.get(KEY, { type: "json" })) || { items: {}, categories: {} };

      if (item) {
        const e = data.items[item] || { sum: 0, count: 0 };
        e.sum += amount;
        e.count += 1;
        data.items[item] = e;
      }
      if (category) {
        const e = data.categories[category] || { sum: 0, count: 0 };
        e.sum += amount;
        e.count += 1;
        data.categories[category] = e;
      }

      await store.setJSON(KEY, data);
      return json({ ok: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: e.message || "Server error" }, 500);
  }
};

export const config = { path: "/api/prefs" };
