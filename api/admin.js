import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const { password, action, name, salary, team, newName } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const raw = await redis.hgetall('players');
  const players = raw ? Object.entries(raw) : [];

  const entry = players.find(([, p]) => p.name.toLowerCase() === name?.toLowerCase());

  if (action === 'setSalary') {
    if (!entry) return res.status(404).json({ error: `Player "${name}" not found` });
    const [id, player] = entry;
    await redis.hset('players', { [id]: { ...player, salary: Number(salary) } });
    return res.json({ ok: true, message: `${player.name} salary set to $${Number(salary).toLocaleString()}` });
  }

  if (action === 'setTeam') {
    if (!entry) return res.status(404).json({ error: `Player "${name}" not found` });
    const [id, player] = entry;
    await redis.hset('players', { [id]: { ...player, team } });
    return res.json({ ok: true, message: `${player.name} moved to ${team}` });
  }

  if (action === 'removePlayer') {
    if (!entry) return res.status(404).json({ error: `Player "${name}" not found` });
    const [id] = entry;
    await redis.hdel('players', id);
    return res.json({ ok: true, message: `${name} removed` });
  }

  if (action === 'addPlayer') {
    const id = `manual_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await redis.hset('players', {
      [id]: { id, name, team: team || 'Free Agent', salary: Number(salary) || 2000000 }
    });
    return res.json({ ok: true, message: `${name} added to ${team || 'Free Agent'} at $${(Number(salary)||2000000).toLocaleString()}` });
  }

  if (action === 'renamePlayer') {
    if (!entry) return res.status(404).json({ error: `Player "${name}" not found` });
    const [id, player] = entry;
    await redis.hset('players', { [id]: { ...player, name: newName } });
    return res.json({ ok: true, message: `${name} renamed to ${newName}` });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
