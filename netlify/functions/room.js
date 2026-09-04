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

// Reads a room along with its ETag, and writes back only if nothing else has
// modified it in the meantime (optimistic concurrency). This is what stops two
// near-simultaneous requests from silently clobbering each other's progress —
// the classic symptom being "an item gets un-awarded and the draft repeats."
async function loadRoomWithEtag(store, code) {
  const result = await store.getWithMetadata(code, { type: "json" });
  if (!result) return null;
  return { room: result.data, etag: result.etag };
}
async function saveRoomIfUnchanged(store, code, room, etag) {
  const result = await store.setJSON(code, room, { onlyIfMatch: etag });
  return !!(result && result.modified !== false);
}
function roleForToken(room, token) {
  if (room.players.host && room.players.host.token === token) return "host";
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

function sanitizeHost(room) {
  const p1 = room.players.p1;
  const p2 = room.players.p2;
  return {
    code: room.code,
    theme: room.theme,
    themeType: room.themeType,
    mode: "hosted",
    phase: room.phase,
    lotIndex: room.themeType === "open" ? room.lotIndex : null,
    totalLots: room.themeType === "open" ? room.lots.length : null,
    currentItem: room.phase === "auction" ? room.currentItem : null,
    currentBid: room.currentBid,
    currentBidder: room.currentBidder === "p1" ? "A" : (room.currentBidder === "p2" ? "B" : null),
    turn: room.turn === "p1" ? "A" : (room.turn === "p2" ? "B" : null),
    resolved: room.resolved,
    bidderAReady: !!p1,
    bidderBReady: !!p2,
    playerA: p1 ? { name: p1.name, budget: p1.budget, items: p1.items } : null,
    playerB: p2 ? { name: p2.name, budget: p2.budget, items: p2.items } : null,
  };
}

function sanitize(room, role) {
  if (role === "host") return sanitizeHost(room);
  const opp = room.players[other(role)];
  const meEligible = room.themeType === "slotted" ? (role === "p1" ? room.eligibleP1 : room.eligibleP2) : true;
  return {
    code: room.code,
    theme: room.theme,
    themeType: room.themeType,
    mode: room.mode || null,
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
    me: { role, name: room.players[role].name, budget: room.players[role].budget, items: room.players[role].items, skipCounts: room.players[role].skipCounts || {} },
    opponent: opp ? { name: opp.name, budget: opp.budget, items: opp.items } : null,
  };
}

export default async (req) => {
  const store = getStore({ name: "rooms", consistency: "strong" });
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

      if (action === "createHosted") {
        const theme = String(body.theme || "").slice(0, 60);
        const lots = Array.isArray(body.lots) ? body.lots.slice(0, 30).map((s) => String(s).slice(0, 60)) : [];
        if (!theme) return json({ error: "Need a theme" }, 400);
        if (lots.length < 5) return json({ error: "Need at least 5 items" }, 400);

        let code, attempts = 0;
        do { code = genCode(); attempts += 1; } while ((await store.get(code)) && attempts < 10);
        const token = genToken();
        const hostName = String(body.name || "").trim().slice(0, 20) || "Host";
        const hostDeviceId = String(body.deviceId || "").trim().slice(0, 64);

        const room = {
          code, theme, themeType: "open", mode: "hosted",
          lots: shuffle(lots), lotIndex: 0, unsold: [],
          nextStarter: "p1", currentItem: null, currentBid: 0, currentBidder: null, turn: "p1", openPasses: 0,
          phase: "lobby", resolved: null,
          players: {
            host: { token, deviceId: hostDeviceId, name: hostName },
            p1: null,
            p2: null,
          },
        };

        await store.setJSON(code, room);
        return json({ code, token, role: "host" });
      }

      if (action === "create") {
        const themeType = body.themeType === "slotted" ? "slotted" : "open";
        const theme = String(body.theme || "").slice(0, 60);
        if (!theme) return json({ error: "Need a theme" }, 400);

        let code, attempts = 0;
        do { code = genCode(); attempts += 1; } while ((await store.get(code)) && attempts < 10);
        const token = genToken();
        const p1Name = String(body.name || "").trim().slice(0, 20) || "Player 1";
        const p1DeviceId = String(body.deviceId || "").trim().slice(0, 64);
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
              p1: { token, deviceId: p1DeviceId, name: p1Name, budget: 20, items: [] },
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
              p1: { token, deviceId: p1DeviceId, name: p1Name, budget: 20, items: [], filled: {}, skipCounts: {} },
              p2: null,
            },
          };
          categories.forEach((c) => { room.players.p1.filled[c.cat] = 0; room.players.p1.skipCounts[c.cat] = 0; });
        }

        await store.setJSON(code, room);
        return json({ code, token, role: "p1" });
      }

      if (action === "join") {
        const code = String(body.code || "").toUpperCase();
        const loaded = await loadRoomWithEtag(store, code);
        if (!loaded) return json({ error: "Room not found" }, 404);
        const room = loaded.room;
        const bidderName = String(body.name || "").trim().slice(0, 20);
        const deviceId = String(body.deviceId || "").trim().slice(0, 64);

        if (room.mode === "hosted") {
          if (room.players.p1 && room.players.p1.deviceId && room.players.p1.deviceId === deviceId) {
            return json({ code, token: room.players.p1.token, role: "p1" });
          }
          if (room.players.p2 && room.players.p2.deviceId && room.players.p2.deviceId === deviceId) {
            return json({ code, token: room.players.p2.token, role: "p2" });
          }
          if (room.players.p1 && room.players.p2) return json({ error: "That room's already full" }, 409);
          const token = genToken();
          let role;
          if (!room.players.p1) {
            room.players.p1 = { token, deviceId, name: bidderName || "Player 1", budget: 20, items: [] };
            role = "p1";
          } else {
            room.players.p2 = { token, deviceId, name: bidderName || "Player 2", budget: 20, items: [] };
            room.phase = "auction";
            drawOpenLot(room);
            role = "p2";
          }
          const ok = await saveRoomIfUnchanged(store, code, room, loaded.etag);
          if (!ok) return json({ error: "That code was just claimed by someone else — try again." }, 409);
          return json({ code, token, role });
        }

        if (room.players.p2 && room.players.p2.deviceId && room.players.p2.deviceId === deviceId) {
          return json({ code, token: room.players.p2.token, role: "p2" });
        }
        if (room.players.p2) return json({ error: "That room's already full" }, 409);

        const token = genToken();
        room.players.p2 = { token, deviceId, name: bidderName || "Player 2", budget: 20, items: [] };
        room.phase = "auction";
        if (room.themeType === "slotted") {
          room.players.p2.filled = {};
          room.players.p2.skipCounts = {};
          room.categories.forEach((c) => { room.players.p2.filled[c.cat] = 0; room.players.p2.skipCounts[c.cat] = 0; });
          drawSlottedLot(room);
        } else {
          drawOpenLot(room);
        }

        const ok = await saveRoomIfUnchanged(store, code, room, loaded.etag);
        if (!ok) return json({ error: "That code was just claimed by someone else — try again." }, 409);
        return json({ code, token, role: "p2" });
      }

      if (action === "raise" || action === "pass") {
        const code = String(body.code || "").toUpperCase();
        const token = body.token || "";
        const loaded = await loadRoomWithEtag(store, code);
        if (!loaded) return json({ error: "Room not found" }, 404);
        const room = loaded.room;
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
            // solo pass — they don't want this specific one; capped at 3 rerolls
            // per category per player so nobody can stall forever
            if (room.themeType === "slotted") {
              const player = room.players[role];
              const cat = room.currentCategory;
              const used = (player.skipCounts && player.skipCounts[cat]) || 0;
              if (used < 3) {
                player.skipCounts[cat] = used + 1;
                drawSlottedLot(room);
              } else {
                room.currentBid = player.budget > 0 ? 1 : 0;
                resolveLot(room, role);
              }
            } else {
              if (room.currentItem) room.unsold.push(room.currentItem);
              drawOpenLot(room);
            }
          }
        }

        const ok = await saveRoomIfUnchanged(store, code, room, loaded.etag);
        if (!ok) return json({ error: "Someone else's action landed first — try again." }, 409);
        return json(sanitize(room, role));
      }

      if (action === "newRound") {
        const code = String(body.code || "").toUpperCase();
        const token = body.token || "";
        const loaded = await loadRoomWithEtag(store, code);
        if (!loaded) return json({ error: "Room not found" }, 404);
        const room = loaded.room;
        const role = roleForToken(room, token);
        if (!role) return json({ error: "Invalid token" }, 403);
        if (room.mode === "hosted" ? role !== "host" : role !== "p1") {
          return json({ error: "Only the room host can start the next round" }, 403);
        }
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
          room.players.p1.skipCounts = {};
          room.players.p2.skipCounts = {};
          categories.forEach((c) => {
            room.players.p1.filled[c.cat] = 0; room.players.p2.filled[c.cat] = 0;
            room.players.p1.skipCounts[c.cat] = 0; room.players.p2.skipCounts[c.cat] = 0;
          });
          drawSlottedLot(room);
        }

        const ok = await saveRoomIfUnchanged(store, code, room, loaded.etag);
        if (!ok) return json({ error: "Someone else's action landed first — try again." }, 409);
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
