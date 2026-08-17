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
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  if (req.method === 'GET') {
    const authHeader = req.headers['authorization'];
    if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } else {
    const { password } = req.body || {};
    if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid password' });
    }
  }

  try {
    const guildId = process.env.DISCORD_GUILD_ID;
    const allRoles = await discordFetch(`/guilds/${guildId}/roles`);
    const roleMap = {};
    allRoles.forEach(r => roleMap[r.id] = r.name);
    let members = [], after = '0';
    while (true) {
      const batch = await discordFetch(`/guilds/${guildId}/members?limit=1000&after=${after}`);
      members = members.concat(batch);
      if (batch.length < 1000) break;
      after = batch[batch.length - 1].user.id;
    }
    const existing = await redis.hgetall('players') || {};

    // FIX: Build name→entry index for all non-snowflake keys using lowercase for reliable matching.
    // The old code stored { key, salary } but lookups used p.name?.toLowerCase() — consistent now.
    const legacyByName = {}; // lowercase username → { key, salary }
    for (const [key, rawVal] of Object.entries(existing)) {
      if (!/^\d{15,20}$/.test(key)) { // not a Discord snowflake
        // BUGFIX: hgetall can hand back either a parsed object or a raw JSON
        // string depending on how the entry was originally written. Only the
        // ID-keyed lookup below was guarding against this — this index wasn't,
        // so val.name was silently `undefined` for string-shaped entries and
        // every legacy record collapsed into a single "undefined" bucket,
        // which meant renamed users could never be matched to their old
        // salary and always fell back to the $2M default.
        const val = typeof rawVal === 'string' ? JSON.parse(rawVal) : rawVal;
        if (val?.name) legacyByName[val.name.toLowerCase()] = { key, salary: val.salary };
      }
    }

    let updated = 0, added = 0, removed = 0;
    const entries = {};
    const toDelete = [];

    for (const member of members) {
      if (member.user?.bot) continue;

      const roleNames = (member.roles || []).map(id => roleMap[id]).filter(Boolean);
      const isCoach = roleNames.includes('Team Coaches');
      const userId = member.user.id;

      if (isCoach) {
        if (existing[userId]) { toDelete.push(userId); removed++; }
        // FIX: use toLowerCase() consistently — the index is keyed by lowercase
        const usernameLower = member.user.username.toLowerCase();
        const leg = legacyByName[usernameLower];
        if (leg && !toDelete.includes(leg.key)) { toDelete.push(leg.key); }
        continue;
      }

      let assignedTeam = null;
      for (const roleId of (member.roles || [])) {
        const match = (roleMap[roleId] || '').match(/^\[([A-Z]+)\]/);
        if (match && ROLE_TO_TEAM[match[1]]) { assignedTeam = ROLE_TO_TEAM[match[1]]; break; }
      }
      if (!assignedTeam) {
        const hasFARole = member.roles.some(roleId => roleMap[roleId] === 'Free Agents');
        if (hasFARole) assignedTeam = 'Free Agent';
      }
      if (!assignedTeam) continue;

      const username = member.user.username;
      // FIX: always use lowercase for the lookup — matches the index built above
      const usernameLower = username.toLowerCase();

      const prevByIdRaw = existing[userId];
      const prevById    = typeof prevByIdRaw === 'string' ? JSON.parse(prevByIdRaw) : prevByIdRaw;
      const prevByName  = legacyByName[usernameLower];

      // Salary priority: snowflake entry > legacy name-keyed entry > default
      const salary = prevById?.salary ?? prevByName?.salary ?? 2000000;

      if (prevById) {
        if (prevById.team !== assignedTeam || prevById.name !== username) updated++;
      } else {
        added++;
      }

      // If a legacy entry existed under a different key, queue it for deletion (de-dupe)
      if (prevByName && !existing[userId]) {
        if (!toDelete.includes(prevByName.key)) toDelete.push(prevByName.key);
      }

      entries[userId] = { id: userId, name: username, team: assignedTeam, salary };
    }

    // BUGFIX: previously, anyone who left the Discord server entirely was
    // never removed — sync only ever added/updated members who were still
    // present, so their old snowflake-keyed entry (with their old username)
    // stayed on the sheet forever. Any ID-keyed entry that no longer
    // corresponds to a current guild member gets cleaned up here. Manual
    // (non-snowflake) entries are left alone since they aren't necessarily
    // tied to a live Discord account.
    const currentMemberIds = new Set(members.filter(m => !m.user?.bot).map(m => m.user.id));
    let left = 0;
    for (const key of Object.keys(existing)) {
      if (/^\d{15,20}$/.test(key) && !currentMemberIds.has(key) && !toDelete.includes(key)) {
        toDelete.push(key);
        left++;
      }
    }

    if (Object.keys(entries).length > 0) {
      await redis.hset('players', entries);
    }
    if (toDelete.length > 0) {
      await redis.hdel('players', ...toDelete);
    }

    return res.json({
      ok: true,
      message: `Sync complete — ${added} added, ${updated} updated, ${removed} staff removed, ${left} left-server entries removed, ${Object.keys(entries).length} total`
    });
  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ error: err.message });
  }
}
