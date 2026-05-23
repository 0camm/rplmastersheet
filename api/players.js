import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const raw = await kv.hgetall('players');
  if (!raw) return res.json([]);

  const players = Object.values(raw);
  res.json(players);
}
