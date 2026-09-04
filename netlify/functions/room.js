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
function other(role) { return role === "p1" ? "p2" : "p1"; }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function roleForToken(room, token) {
  if (room.players.p1 && room.players.p1.token === token) return "p1";
  if (room.players.p2 && room.players.p2.token === token) return "p2";
  return null;
}

// ---------- lot lifecycle ----------

function startTurnAuction(room) {
  room.currentBid = 0;
  room.currentBidder = null;
  room.openPasses = 0;
  room.turn = room.nextStarter;
}

function drawOpenLot(room) {
  const p1Needs = room.players.p1.items.length < 5;
  const p2Needs = room.players.p2.items.length < 5;
  if (!p1Needs && !p2Needs) {
    room.phase = "results";
    room.currentItem = null;
    return;
  }

  let item;
  if (room.lotIndex < room.lots.length) {
    item = room.lots[room.lotIndex];
    room.lotIndex += 1;
  } else if (room.unsold.length) {
    item = room.unsold.shift();
  } else {
    item = "Bonus pick";
  }
  room.currentItem = item;
  room.eligibleP1 = p1Needs;
  room.eligibleP2 = p2Needs;

  if (p1Needs && p2Needs) {
    startTurnAuction(room);
  } else {
    // only one side still needs it — they get a solo turn to claim it themselves,
    // paying whatever they choose; only truly free if they're down to $0
    const soloRole = p1Needs ? "p1" : "p2";
    const solo = room.players[soloRole];
    room.turn = soloRole;
    room.currentBid = 0;
    room.currentBidder = null;
    room.openPasses = 0;
    if (solo.budget === 0) {
      resolveLot(room, soloRole);
    }
  }
}

function drawSlottedLot(room) {
  let info = room.categories[room.catIndex];
  while (info && room.players.p1.filled[info.cat] >= info.count && room.players.p2.filled[info.cat] >= info.count) {
    room.catIndex += 1;
    info = room.categories[room.catIndex];
  }
  if (!info) {
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
  room.eligibleP1 = p1Needs;
  room.eligibleP2 = p2Needs;

  if (p1Needs && p2Needs) {
    startTurnAuction(room);
  } else {
    // only one side still needs this position — solo turn to claim it themselves,
    // paying whatever they choose; only free if they're down to $0
    const soloRole = p1Needs ? "p1" : "p2";
    const solo = room.players[soloRole];
    room.turn = soloRole;
    room.currentBid = 0;
    room.currentBidder = null;
    room.openPasses = 0;
    if (solo.budget === 0) {
      resolveLot(room, soloRole);
    }
  }
}

function resolveLot(room, winnerRoleOrNull) {
  if (room.themeType === "slotted") {
    const item = room.currentItem, cat = room.currentCategory, categoryLabel = room.currentCategoryLabel, price = room.currentBid;
    if (winnerRoleOrNull) {
      const w = room.players[winnerRoleOrNull];
      w.budget -= price;
      w.items.push({ n: item, p: price, freebie: false, cat });
      w.filled[cat] = (w.filled[cat] || 0) + 1;
    }
    room.resolved = { item, price, winner: winnerRoleOrNull, categoryLabel };
    room.nextStarter = other(room.nextStarter);
    drawSlottedLot(room);
  } else {
    const item = room.currentItem;
    const price = room.currentBid;
    if (winnerRoleOrNull) {
      const w = room.players[winnerRoleOrNull];
      w.budget -= price;
      w.items.push({ n: item, p: price, freebie: false });
    } else {
      room.unsold.push(item);
    }
    room.resolved = { item, price, winner: winnerRoleOrNull, categoryLabel: null };
    room.nextStarter = other(room.nextStarter);
    drawOpenLot(room);
  }
}

// ---------- sanitize ----------

function sanitize(room, role) {
  const opp = room.players[other(role)];
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
    currentBid: room.currentBid,
    currentBidder: room.currentBidder === role ? "me" : (room.currentBidder ? "opp" : null),
    turn: room.turn === role ? "me" : "opp",
    resolved: room.resolved,
    me: { role, name: room.players[role].name, budget: room.players[role].budget, items: room.players[role].items },
    opponent: opp ? { name: opp.name, budget: opp.budget, items: opp.items } : null,
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

        let code, attempts = 0;
        do { code = genCode(); attempts += 1; } while ((await store.get(code)) && attempts < 10);
        const token = genToken();
        const p1Name = String(body.name || "").trim().slice(0, 20) || "Player 1";
        let room;

        if (themeType === "open") {
          const lots = Array.isArray(body.lots) ? body.lots.slice(0, 30).map((s) => String(s).slice(0, 60)) : [];
          if (lots.length < 5) return json({ error: "Need at least 5 items" }, 400);
          room = {
            code, theme, themeType: "open",
            lots: shuffle(lots), lotIndex: 0, unsold: [],
            nextStarter: "p1", currentItem: null, currentBid: 0, currentBidder: null, turn: "p1", openPasses: 0,
            phase: "lobby", resolved: null,
            players: {
              p1: { token, name: p1Name, budget: 20, items: [] },
              p2: null,
            },
          };
        } else {
          const categories = Array.isArray(body.categories) ? body.categories : [];
          const pools = body.pools && typeof body.pools === "object" ? body.pools : {};
          if (!categories.length) return json({ error: "Missing football categories" }, 400);
          const shuffledPools = {};
          Object.keys(pools).forEach((k) => { shuffledPools[k] = Array.isArray(pools[k]) ? pools[k].slice() : []; });
          room = {
            code, theme, themeType: "slotted",
            categories, pools: shuffledPools, catIndex: 0,
            nextStarter: "p1", currentItem: null, currentCategory: null, currentCategoryLabel: null,
            currentBid: 0, currentBidder: null, turn: "p1", openPasses: 0,
            eligibleP1: true, eligibleP2: true,
            phase: "lobby", resolved: null,
            players: {
              p1: { token, name: p1Name, budget: 20, items: [], filled: {} },
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
        room.players.p2 = { token, name: String(body.name || "").trim().slice(0, 20) || "Player 2", budget: 20, items: [] };
        room.phase = "auction";
        if (room.themeType === "slotted") {
          room.players.p2.filled = {};
          room.categories.forEach((c) => { room.players.p2.filled[c.cat] = 0; });
          drawSlottedLot(room);
        } else {
          drawOpenLot(room);
        }

        await store.setJSON(code, room);
        return json({ code, token, role: "p2" });
      }

      if (action === "raise" || action === "pass") {
        const code = String(body.code || "").toUpperCase();
        const token = body.token || "";
        const room = await store.get(code, { type: "json" });
        if (!room) return json({ error: "Room not found" }, 404);
        if (room.phase !== "auction") return json({ error: "The auction isn't running" }, 400);
        const role = roleForToken(room, token);
        if (!role) return json({ error: "Invalid token" }, 403);
        if (room.turn !== role) return json({ error: "It's not your turn" }, 400);

        if (action === "raise") {
          const amt = Math.floor(Number(body.amount) || 0);
          const budget = room.players[role].budget;
          if (amt <= room.currentBid) return json({ error: "Bid must beat the current bid" }, 400);
          if (amt > budget) return json({ error: "You can't afford that" }, 400);

          const bothEligible = room.eligibleP1 && room.eligibleP2;
          room.currentBid = amt;
          if (bothEligible) {
            room.currentBidder = role;
            room.openPasses = 0;
            room.turn = other(role);
          } else {
            // solo lot — nobody to respond, this claims it immediately
            resolveLot(room, role);
          }
        } else {
          const bothEligible = room.eligibleP1 && room.eligibleP2;
          if (bothEligible) {
            if (room.currentBidder === null) {
              room.openPasses += 1;
              if (room.openPasses >= 2) {
                resolveLot(room, null);
              } else {
                room.turn = other(role);
              }
            } else {
              resolveLot(room, room.currentBidder);
            }
          } else {
            // solo pass — they don't want this specific one, redraw another
            if (room.themeType === "slotted") {
              drawSlottedLot(room);
            } else {
              if (room.currentItem) room.unsold.push(room.currentItem);
              drawOpenLot(room);
            }
          }
        }

        await store.setJSON(code, room);
        return json(sanitize(room, role));
      }

      if (action === "newRound") {
        const code = String(body.code || "").toUpperCase();
        const token = body.token || "";
        const room = await store.get(code, { type: "json" });
        if (!room) return json({ error: "Room not found" }, 404);
        const role = roleForToken(room, token);
        if (!role) return json({ error: "Invalid token" }, 403);
        if (role !== "p1") return json({ error: "Only the room host can start the next round" }, 403);
        if (room.phase !== "results") return json({ error: "This round isn't finished yet" }, 400);

        const themeType = body.themeType === "slotted" ? "slotted" : "open";
        const theme = String(body.theme || "").slice(0, 60);
        if (!theme) return json({ error: "Need a theme" }, 400);

        room.theme = theme;
        room.themeType = themeType;
        room.resolved = null;
        room.nextStarter = "p1";
        room.players.p1.budget = 20;
        room.players.p1.items = [];
        room.players.p2.budget = 20;
        room.players.p2.items = [];

        if (themeType === "open") {
          const lots = Array.isArray(body.lots) ? body.lots.slice(0, 30).map((s) => String(s).slice(0, 60)) : [];
          if (lots.length < 5) return json({ error: "Need at least 5 items" }, 400);
          room.lots = shuffle(lots);
          room.lotIndex = 0;
          room.unsold = [];
          drawOpenLot(room);
        } else {
          const categories = Array.isArray(body.categories) ? body.categories : [];
          const pools = body.pools && typeof body.pools === "object" ? body.pools : {};
          if (!categories.length) return json({ error: "Missing football categories" }, 400);
          const shuffledPools = {};
          Object.keys(pools).forEach((k) => { shuffledPools[k] = Array.isArray(pools[k]) ? pools[k].slice() : []; });
          room.categories = categories;
          room.pools = shuffledPools;
          room.catIndex = 0;
          room.players.p1.filled = {};
          room.players.p2.filled = {};
          categories.forEach((c) => { room.players.p1.filled[c.cat] = 0; room.players.p2.filled[c.cat] = 0; });
          drawSlottedLot(room);
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
