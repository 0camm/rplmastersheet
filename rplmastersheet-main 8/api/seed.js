// api/seed.js
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  const { password, players } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  if (!Array.isArray(players)) return res.status(400).json({ error: 'players must be an array' });

  // Wipe all existing players first to avoid duplicates
  await redis.del('players');

  if (players.length === 0) {
    return res.json({ ok: true, message: 'Roster cleared' });
  }

  const entries = {};
  players.forEach((p, i) => {
    // FIX: if a Discord snowflake ID is provided, use it as the key so this
    // entry is treated identically to one written by /api/sync or /api/callback.
    // Salary will survive future syncs with no name-matching required.
    const isSnowflake = p.discordId && /^\d{15,20}$/.test(p.discordId);
    const id = isSnowflake
      ? p.discordId
      : `manual_${Date.now()}_${i}_${p.name.replace(/\s+/g, '_')}`;

    entries[id] = { id, name: p.name, team: p.team, salary: Number(p.salary) || 2000000 };
  });

  await redis.hset('players', entries);

  const withId = Object.values(entries).filter(e => /^\d{15,20}$/.test(e.id)).length;
  const manual = Object.keys(entries).length - withId;
  return res.json({
    ok: true,
    message: `${Object.keys(entries).length} players seeded (${withId} by Discord ID, ${manual} manual)`
  });
}
