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

  // purgeStaff: cross-reference Discord roles, delete anyone who is Coach or Owner
  if (action === 'purgeStaff') {
    const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
    const DISCORD_GUILD_ID  = process.env.DISCORD_GUILD_ID;
    async function dFetch(path) {
      const r = await fetch(`https://discord.com/api/v10${path}`, {
        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
      });
      if (!r.ok) throw new Error(`Discord ${r.status} on ${path}`);
      return r.json();
    }
    const allRoles = await dFetch(`/guilds/${DISCORD_GUILD_ID}/roles`);
    const roleMap = {};
    allRoles.forEach(r => roleMap[r.id] = r.name);
    let members = [], after = '0';
    while (true) {
      const batch = await dFetch(`/guilds/${DISCORD_GUILD_ID}/members?limit=1000&after=${after}`);
      members = members.concat(batch);
      if (batch.length < 1000) break;
      after = batch[batch.length - 1].user.id;
    }
    const coachIds = new Set();
    const coachNames = new Set();
    for (const m of members) {
      if (m.user?.bot) continue;
      const roleNames = (m.roles || []).map(id => roleMap[id]).filter(Boolean);
      // Only purge coaches — owners keep their salary cap entries
      if (roleNames.includes('Team Coaches')) {
        coachIds.add(m.user.id);
        coachNames.add(m.user.username.toLowerCase());
      }
    }
    // Delete any KV entry whose key OR name matches a coach
    const toDelete = players
      .filter(([id, p]) => coachIds.has(id) || coachNames.has(p.name?.toLowerCase()))
      .map(([id]) => id);
    if (toDelete.length > 0) await redis.hdel('players', ...toDelete);
    return res.json({ ok: true, message: `Purged ${toDelete.length} coach entr${toDelete.length===1?'y':'ies'} from players` });
  }

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
    // Delete ALL entries with this name (catches duplicates)
    const allMatches = players.filter(([, p]) => p.name.toLowerCase() === name?.toLowerCase());
    if (!allMatches.length) return res.status(404).json({ error: `Player "${name}" not found` });
    await redis.hdel('players', ...allMatches.map(([id]) => id));
    return res.json({ ok: true, message: `${name} removed (${allMatches.length} entr${allMatches.length===1?'y':'ies'})` });
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
