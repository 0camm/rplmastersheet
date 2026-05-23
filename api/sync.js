// api/sync.js — called by Vercel Cron, syncs Discord roles → player teams
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const ROLE_TO_TEAM = {
  'ATL': 'Atlanta Hawks','BKN': 'Brooklyn Nets','BOS': 'Boston Celtics',
  'CHI': 'Chicago Bulls','CLE': 'Cleveland Cavaliers','CHA': 'Charlotte Hornets',
  'DAL': 'Dallas Mavericks','DEN': 'Denver Nuggets','DET': 'Detroit Pistons',
  'GSW': 'Golden State Warriors','HOU': 'Houston Rockets','IND': 'Indiana Pacers',
  'LAC': 'LA Clippers','LAL': 'Los Angeles Lakers','MIA': 'Miami Heat',
  'MIL': 'Milwaukee Bucks','MEM': 'Memphis Grizzlies','MIN': 'Minnesota Timberwolves',
  'NOP': 'New Orleans Pelicans','NYK': 'New York Knicks','OKC': 'Oklahoma City Thunder',
  'ORL': 'Orlando Magic','PHI': 'Philadelphia 76ers','PHX': 'Phoenix Suns',
  'POR': 'Portland Trail Blazers','SAC': 'Sacramento Kings','SAN': 'San Antonio Spurs',
  'TOR': 'Toronto Raptors','UTA': 'Utah Jazz','WAS': 'Washington Wizards',
};

async function discordFetch(path) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Discord ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

export default async function handler(req, res) {
  // Allow manual trigger via admin, or automated cron call
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  // Optional: protect manual POST triggers with admin password
  if (req.method === 'POST') {
    const { password } = req.body || {};
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid password' });
    }
  }

  try {
    const guildId = process.env.DISCORD_GUILD_ID;

    // Fetch all roles
    const allRoles = await discordFetch(`/guilds/${guildId}/roles`);
    const roleMap = {};
    allRoles.forEach(r => roleMap[r.id] = r.name);

    // Fetch all members (paginate)
    let members = [], after = '0';
    while (true) {
      const batch = await discordFetch(`/guilds/${guildId}/members?limit=1000&after=${after}`);
      members = members.concat(batch);
      if (batch.length < 1000) break;
      after = batch[batch.length - 1].user.id;
    }

    // Get existing players to preserve salaries
    const existing = await redis.hgetall('players') || {};

    let updated = 0, added = 0;
    const entries = {};

    for (const member of members) {
      if (member.user?.bot) continue;

      let assignedTeam = null;
      for (const roleId of (member.roles || [])) {
        const match = (roleMap[roleId] || '').match(/^\[([A-Z]+)\]/);
        if (match && ROLE_TO_TEAM[match[1]]) { assignedTeam = ROLE_TO_TEAM[match[1]]; break; }
      }
      if (!assignedTeam) continue;

      const userId = member.user.id;
      const username = member.user.username;
      const prev = existing[userId];
      const salary = prev ? prev.salary : 2000000; // preserve existing salary

      if (prev) {
        if (prev.team !== assignedTeam || prev.name !== username) updated++;
      } else {
        added++;
      }

      entries[userId] = { id: userId, name: username, team: assignedTeam, salary };
    }

    if (Object.keys(entries).length > 0) {
      await redis.hset('players', entries);
    }

    return res.json({
      ok: true,
      message: `Sync complete — ${added} added, ${updated} updated, ${Object.keys(entries).length} total`
    });

  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ error: err.message });
  }
}
