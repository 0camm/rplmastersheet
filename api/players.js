import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const raw = await redis.hgetall('players');
  if (!raw) return res.json([]);

  const players = Object.values(raw);
  res.json(players);
}
