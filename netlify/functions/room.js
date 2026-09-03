import { getStore } from "@netlify/blobs";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function genCode(len = 5) {
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
function genToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function roleForToken(room, token) {
  if (room.players.p1 && room.players.p1.token === token) return "p1";
  if (room.players.p2 && room.players.p2.token === token) return "p2";
  return null;
}

function computeSlottedLot(room) {
  let info = room.categories[room.catIndex];
  while (info && room.players.p1.filled[info.cat] >= info.count && room.players.p2.filled[info.cat] >= info.count) {
    room.catIndex += 1;
    info = room.categories[room.catIndex];
  }
  if (!info) {
    applyLeftoversSlotted(room);
    room.phase = "results";
    room.currentItem = null;
    room.currentCategory = null;
    room.currentCategoryLabel = null;
    return;
  }
  const p1Needs = room.players.p1.filled[info.cat] < info.count;
  const p2Needs = room.players.p2.filled[info.cat] < info.count;

  room.currentCategory = info.cat;
  room.currentCategoryLabel = info.label;

  const pool = room.pools[info.cat];
  room.currentItem = pool.length ? pool.shift() : "Free agent " + info.label.toLowerCase();

  room.players.p1.bid = p1Needs ? null : 0;
  room.players.p1.submitted = !p1Needs;
  room.players.p2.bid = p2Needs ? null : 0;
  room.players.p2.submitted = !p2Needs;
  room.eligibleP1 = p1Needs;
  room.eligibleP2 = p2Needs;
}

function applyLeftoversSlotted(room) {
  ["p1", "p2"].forEach((role) => {
    const p = room.players[role];
    room.categories.forEach((info) => {
      while (p.filled[info.cat] < info.count) {
        p.items.push({ n: "Free agent " + info.label.toLowerCase(), p: 0, freebie: true, cat: info.cat });
        p.filled[info.cat] += 1;
      }
    });
  });
}

function applyLeftoversOpen(room) {
  ["p1", "p2"].forEach((role) => {
    const other = role === "p1" ? "p2" : "p1";
    const me = room.players[role];
    const opp = room.players[other];
    if (me.items.length < 5 && opp.items.length >= 5) {
      while (me.items.length < 5 && room.unsold.length) {
        const it = room.unsold.shift();
        me.items.push({ n: it, p: 0, freebie: true });
      }
    }
  });
}

function sanitize(room, role) {
  const otherRole = role === "p1" ? "p2" : "p1";
  const me = room.players[role];
  const opp = room.players[otherRole];
  const meEligible = room.themeType === "slotted" ? (role === "p1" ? room.eligibleP1 : room.eligibleP2) : true;

  return {
    code: room.code,
    theme: room.theme,
    themeType: room.themeType,
    phase: room.phase,
    lotIndex: room.themeType === "open" ? room.lotIndex : null,
    totalLots: room.themeType === "open" ? room.lots.length : null,
    currentItem: room.phase === "auction" ? room.currentItem : null,
    currentCategoryLabel: room.themeType === "slotted" ? room.currentCategoryLabel : null,
    meEligible,
    resolved: room.resolved,
    me: { role, name: me.name, budget: me.budget, items: me.items, submitted: me.submitted },
    opponent: opp
      ? { name: opp.name, budget: opp.budget, items: opp.items, submitted: opp.submitted }
      : null,
  };
}

export default async (req) => {
  const store = getStore("rooms");
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      const code = (url.searchParams.get("code") || "").toUpperCase();
      const token = url.searchParams.get("token") || "";
      const room = await store.get(code, { type: "json" });
      if (!room) return json({ error: "Room not found" }, 404);
      const role = roleForToken(room, token);
      if (!role) return json({ error: "Invalid token" }, 403);
      return json(sanitize(room, role));
    }

    if (req.method === "POST") {
      const body = await req.json();
      const action = body.action;

      if (action === "create") {
        const themeType = body.themeType === "slotted" ? "slotted" : "open";
        const theme = String(body.theme || "").slice(0, 60);
        if (!theme) return json({ error: "Need a theme" }, 400);

        let code;
        let attempts = 0;
        do {
          code = genCode();
          attempts += 1;
        } while ((await store.get(code)) && attempts < 10);

        const token = genToken();
        let room;

        if (themeType === "open") {
          const lots = Array.isArray(body.lots) ? body.lots.slice(0, 30).map((s) => String(s).slice(0, 60)) : [];
          if (lots.length < 5) return json({ error: "Need at least 5 items" }, 400);
          room = {
            code, theme, themeType: "open",
            lots: shuffle(lots).slice(0, 10), lotIndex: 0, unsold: [],
            phase: "lobby", resolved: null,
            players: {
              p1: { token, name: "Player 1", budget: 20, items: [], bid: null, submitted: false },
              p2: null,
            },
          };
        } else {
          const categories = Array.isArray(body.categories) ? body.categories : [];
          const pools = body.pools && typeof body.pools === "object" ? body.pools : {};
          if (!categories.length) return json({ error: "Missing football categories" }, 400);
          const shuffledPools = {};
          Object.keys(pools).forEach((k) => { shuffledPools[k] = shuffle(pools[k]); });
          room = {
            code, theme, themeType: "slotted",
            categories, pools: shuffledPools, catIndex: 0,
            currentItem: null, currentCategory: null, currentCategoryLabel: null,
            eligibleP1: true, eligibleP2: true,
            phase: "lobby", resolved: null,
            players: {
              p1: { token, name: "Player 1", budget: 20, items: [], bid: null, submitted: false, filled: {} },
              p2: null,
            },
          };
          categories.forEach((c) => { room.players.p1.filled[c.cat] = 0; });
        }

        await store.setJSON(code, room);
        return json({ code, token, role: "p1" });
      }

      if (action === "join") {
        const code = String(body.code || "").toUpperCase();
        const room = await store.get(code, { type: "json" });
        if (!room) return json({ error: "Room not found" }, 404);
        if (room.players.p2) return json({ error: "That room's already full" }, 409);

        const token = genToken();
        room.players.p2 = { token, name: "Player 2", budget: 20, items: [], bid: null, submitted: false };
        if (room.themeType === "slotted") {
          room.players.p2.filled = {};
          room.categories.forEach((c) => { room.players.p2.filled[c.cat] = 0; });
          room.phase = "auction";
          computeSlottedLot(room);
        } else {
          room.phase = "auction";
        }

        await store.setJSON(code, room);
        return json({ code, token, role: "p2" });
      }

      if (action === "bid") {
        const code = String(body.code || "").toUpperCase();
        const token = body.token || "";
        const room = await store.get(code, { type: "json" });
        if (!room) return json({ error: "Room not found" }, 404);
        if (room.phase !== "auction") return json({ error: "The auction isn't running" }, 400);
        const role = roleForToken(room, token);
        if (!role) return json({ error: "Invalid token" }, 403);

        const me = room.players[role];
        if (me.submitted) return json(sanitize(room, role));

        const amt = Math.max(0, Math.min(me.budget, Math.floor(Number(body.amount) || 0)));
        me.bid = amt;
        me.submitted = true;

        if (room.players.p1.submitted && room.players.p2.submitted) {
          const p1 = room.players.p1;
          const p2 = room.players.p2;
          let winner = null;
          if (p1.bid > p2.bid) winner = "p1";
          else if (p2.bid > p1.bid) winner = "p2";

          if (room.themeType === "slotted") {
            const item = room.currentItem;
            const cat = room.currentCategory;
            if (winner) {
              const w = room.players[winner];
              w.budget -= w.bid;
              w.items.push({ n: item, p: w.bid, freebie: false, cat });
              w.filled[cat] = (w.filled[cat] || 0) + 1;
            }
            room.resolved = {
              item, p1Bid: p1.bid, p2Bid: p2.bid, winner,
              categoryLabel: room.currentCategoryLabel,
              eligibleP1: room.eligibleP1, eligibleP2: room.eligibleP2,
            };
            computeSlottedLot(room);
          } else {
            const item = room.lots[room.lotIndex];
            if (winner) {
              const w = room.players[winner];
              w.budget -= w.bid;
              w.items.push({ n: item, p: w.bid, freebie: false });
            } else {
              room.unsold.push(item);
            }
            room.resolved = { item, p1Bid: p1.bid, p2Bid: p2.bid, winner, categoryLabel: null };
            p1.bid = null; p1.submitted = false;
            p2.bid = null; p2.submitted = false;
            room.lotIndex += 1;
            if (room.lotIndex >= room.lots.length) {
              applyLeftoversOpen(room);
              room.phase = "results";
            }
          }
        }

        await store.setJSON(code, room);
        return json(sanitize(room, role));
      }

      return json({ error: "Unknown action" }, 400);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: e.message || "Server error" }, 500);
  }
};

export const config = { path: "/api/room" };
