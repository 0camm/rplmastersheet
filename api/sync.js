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
// Salary-cap roles, mapped role ID -> cap amount. If a member holds more than
// one of these (shouldn't normally happen), the HIGHEST value wins.
const ROLE_TO_SALARY = {
  '1538934486815735949': 22000000, // $22M
  '1538934567342182521': 20000000, // $20M
  '1538934663223967875': 18000000, // $18M
  '1538934730970632302': 15000000, // $15M
  '1538934599239868456': 12000000, // $12M
  '1538934791527989332': 10000000, // $10M
  '1538934845034729664': 8000000,  // $8M
  '1538934920510971974': 5000000,  // $5M
  '1538934966929334342': 2000000,  // $2M
};
// Returns the dollar value of a member's highest salary-cap role, or null if
// they don't currently hold any of the cap roles.
function highestCapRoleSalary(memberRoleIds) {
  let highest = null;
  for (const roleId of memberRoleIds) {
    const amount = ROLE_TO_SALARY[roleId];
    if (amount != null && (highest === null || amount > highest)) highest = amount;
  }
  return highest;
}
// Reverse of ROLE_TO_SALARY — dollar amount -> role ID. Used to figure out
// which single role a player SHOULD hold once their cap is known.
const SALARY_TO_ROLE = Object.fromEntries(
  Object.entries(ROLE_TO_SALARY).map(([roleId, amount]) => [amount, roleId])
);
async function discordFetch(path, options = {}) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok && res.status !== 204) throw new Error(`Discord ${res.status} on ${path}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
// Makes a member's cap roles match their stored salary: adds the role for
// their current cap if missing, and strips any other cap role they're
// holding so a player never ends up wearing two cap roles at once.
async function syncCapRole(guildId, userId, memberRoleIds, salary) {
  const desiredRoleId = SALARY_TO_ROLE[salary];
  const heldCapRoleIds = memberRoleIds.filter((id) => ROLE_TO_SALARY[id] != null);
  let assigned = false, removed = 0;

  if (desiredRoleId && !heldCapRoleIds.includes(desiredRoleId)) {
    await discordFetch(`/guilds/${guildId}/members/${userId}/roles/${desiredRoleId}`, { method: 'PUT' });
    assigned = true;
  }
  for (const roleId of heldCapRoleIds) {
    if (roleId === desiredRoleId) continue;
    await discordFetch(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: 'DELETE' });
    removed++;
  }
  return { assigned, removed };
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

    let updated = 0, added = 0, removed = 0, rolesAssigned = 0, rolesRemoved = 0;
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

      // Salary priority: highest held salary-cap role > snowflake entry >
      // legacy name-keyed entry > default. A player with NO cap role yet
      // keeps whatever was already stored — never falls back to a reset.
      const capRoleSalary = highestCapRoleSalary(member.roles || []);
      const salary = capRoleSalary ?? prevById?.salary ?? prevByName?.salary ?? 2000000;

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

      // Push the role onto Discord to match the salary we just resolved.
      // Wrapped per-member so one permission/hierarchy hiccup on one player
      // logs and moves on instead of aborting the whole sync.
      try {
        const roleResult = await syncCapRole(guildId, userId, member.roles || [], salary);
        if (roleResult.assigned) rolesAssigned++;
        rolesRemoved += roleResult.removed;
      } catch (roleErr) {
        console.error(`Cap role sync failed for ${username} (${userId}):`, roleErr.message);
      }
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
      message: `Sync complete — ${added} added, ${updated} updated, ${removed} staff removed, ${left} left-server entries removed, ${rolesAssigned} cap roles assigned, ${rolesRemoved} stale cap roles removed, ${Object.keys(entries).length} total`
    });
  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ error: err.message });
  }
}
