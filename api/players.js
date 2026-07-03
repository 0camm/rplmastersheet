import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const raw = await redis.hgetall('players');
  if (!raw) return res.json([]);

  // BUGFIX: hgetall can return values as parsed objects or as raw JSON
  // strings depending on how an entry was written. This endpoint assumed
  // objects, so string-shaped entries rendered as blank/undefined rows
  // instead of being filtered out or displayed correctly.
  // Expose id so the frontend can key operations by stable Discord ID, not mutable username
  const players = Object.values(raw)
    .map(v => (typeof v === 'string' ? JSON.parse(v) : v))
    .filter(p => p && p.name)
    .map(({ id, name, team, salary }) => ({ id, name, team, salary }));
  res.json(players);
}
