import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const raw = await redis.hgetall('players');
  if (!raw) return res.json([]);

  // Expose id so the frontend can key operations by stable Discord ID, not mutable username
  const players = Object.values(raw).map(({ id, name, team, salary }) => ({ id, name, team, salary }));
  res.json(players);
}
