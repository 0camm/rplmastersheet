// api/player-cap.js — Player Cap Viewer backend
//
// Reads from the SAME 'players' Redis hash that /api/players, /api/admin,
// and /api/sync use, so the Cap Viewer always shows the exact same salary
// figure that's used in roster/team cap calculations. There is no separate
// "cap" store to fall out of sync with.
//
// Every entry is keyed by permanent Discord User ID (the hash key itself,
// e.g. "123456789012345678"), never by username/display name. A username
// change never touches the key, so the stored cap survives renames and
// survives a player moving between rostered / free agent / off-roster.
//
// Manually-added players (via the admin panel, before they've ever synced
// from Discord) are keyed with a "manual_..." id instead of a snowflake —
// those are also returned normally, just without a Discord ID to display.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const isSnowflake = (key) => /^\d{15,20}$/.test(key);

async function getAllPlayers() {
  const raw = await redis.hgetall('players');
  if (!raw) return [];
  // Same defensive normalization used across players.js/admin.js/sync.js:
  // hgetall can hand back either a parsed object or a raw JSON string
  // depending on how the entry was originally written.
  return Object.entries(raw)
    .map(([key, v]) => {
      const val = typeof v === 'string' ? JSON.parse(v) : v;
      if (!val || !val.name) return null;
      return {
        id: key,
        discordId: isSnowflake(key) ? key : null,
        name: val.name,
        team: val.team || null,
        // Never silently default here — if a stored record has no salary
        // for some reason, surface that as null rather than inventing $2M.
        salary: typeof val.salary === 'number' ? val.salary : null,
      };
    })
    .filter(Boolean);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');

  try {
    const players = await getAllPlayers();
    const { id, q } = req.query;

    // Exact lookup by permanent Discord User ID (or manual record id) —
    // used when the viewer opens a specific player's profile.
    if (id) {
      const player = players.find(p => p.id === id);
      if (!player) return res.json({ found: false });
      return res.json({ found: true, player });
    }

    // Search by username/display name OR by Discord User ID substring —
    // used for the live-search box.
    if (q) {
      const query = String(q).trim().toLowerCase();
      const results = players
        .filter(p =>
          p.name.toLowerCase().includes(query) ||
          (p.discordId && p.discordId.includes(query))
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 25);
      return res.json({ results });
    }

    // No "q" or "id" provided — return every player in the store (used by
    // the Player Cap Viewer, which lists all players rather than searching
    // for one). Sorted A–Z; the frontend re-sorts/paginates as needed.
    const all = players.slice().sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ results: all });
  } catch (err) {
    console.error('player-cap error:', err);
    return res.status(500).json({ error: err.message });
  }
}
