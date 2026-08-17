// api/player-cap.js
//
// Standalone cap store keyed by permanent Roblox User ID — deliberately
// separate from the `players` hash used by /api/sync, /api/admin, etc.
// (which is keyed by Discord ID/username and depends on Discord roles).
// This lets any player's individual cap be looked up whether they're
// rostered, a free agent, or on no team, and survives username changes
// since the key is never the name.
//
// Redis hash: "roblox_caps"  key = robloxId (string of digits)
//   value = { robloxId, username, team, salary }
//   team: '' (none) | 'Free Agent' | an NBA team name

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

function normalize(raw) {
  return Object.fromEntries(
    Object.entries(raw || {}).map(([k, v]) => [k, typeof v === 'string' ? JSON.parse(v) : v])
  );
}

function isRobloxId(s) {
  return /^\d{1,20}$/.test(s);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const { q, robloxId } = req.query;

    if (robloxId) {
      const raw = await redis.hget('roblox_caps', String(robloxId));
      if (!raw) return res.json({ found: false });
      const player = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return res.json({ found: true, player });
    }

    const query = (q || '').trim();
    if (!query) return res.json({ results: [] });

    const all = normalize(await redis.hgetall('roblox_caps'));
    const qLower = query.toLowerCase();
    const qDigits = query.replace(/\D/g, '');

    const scored = [];
    for (const p of Object.values(all)) {
      if (!p || !p.username || !p.robloxId) continue;
      const nameLower = p.username.toLowerCase();
      let score = -1;
      if (qDigits && p.robloxId === qDigits) score = 100;
      else if (qDigits && p.robloxId.startsWith(qDigits)) score = 80;
      else if (nameLower === qLower) score = 90;
      else if (nameLower.startsWith(qLower)) score = 70;
      else if (nameLower.includes(qLower)) score = 50;
      if (score >= 0) scored.push({ p, score });
    }
    scored.sort((a, b) => b.score - a.score || a.p.username.localeCompare(b.p.username));
    const results = scored.slice(0, 25).map(s => s.p);
    return res.json({ results });
  }

  if (req.method === 'POST') {
    const { password, action, robloxId, username, team, salary } = req.body || {};
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    if (action === 'upsert') {
      const id = String(robloxId || '').trim();
      const name = String(username || '').trim();
      if (!isRobloxId(id)) return res.status(400).json({ error: 'Enter a valid numeric Roblox User ID.' });
      if (!name) return res.status(400).json({ error: 'Enter a username.' });
      const salaryNum = Number(salary);
      if (!Number.isFinite(salaryNum) || salaryNum < 0) {
        return res.status(400).json({ error: 'Enter a valid salary.' });
      }
      const record = { robloxId: id, username: name, team: team || '', salary: salaryNum };
      await redis.hset('roblox_caps', { [id]: record });
      return res.json({ ok: true, message: `${name} (${id}) saved at $${salaryNum.toLocaleString()}`, player: record });
    }

    if (action === 'remove') {
      const id = String(robloxId || '').trim();
      if (!isRobloxId(id)) return res.status(400).json({ error: 'Enter a valid numeric Roblox User ID.' });
      const existed = await redis.hget('roblox_caps', id);
      if (!existed) return res.status(404).json({ error: 'No cap record found for that Roblox User ID.' });
      await redis.hdel('roblox_caps', id);
      return res.json({ ok: true, message: `Removed cap record ${id}` });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).end();
}
