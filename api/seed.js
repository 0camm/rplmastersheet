import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  const { password, players } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  if (!Array.isArray(players)) return res.status(400).json({ error: 'players must be an array' });

  const entries = {};
  players.forEach((p, i) => {
    const id = `seed_${i}_${p.name.replace(/\s+/g, '_')}`;
    entries[id] = { id, name: p.name, team: p.team, salary: Number(p.salary) };
  });

  await kv.hset('players', entries);
  return res.json({ ok: true, message: `${players.length} players seeded` });
}
