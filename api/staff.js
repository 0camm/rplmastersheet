// api/staff.js — returns Franchise Owners and Team Coaches from Discord
import { Redis } from '@upstash/redis';
import { ROLE_TO_TEAM } from './_lib/discord-teams.js';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const FRANCHISE_OWNER_ROLE = 'Franchise Owners';
  const TEAM_COACH_ROLE      = 'Team Coaches';

  async function discordFetch(path) {
    const r = await fetch(`https://discord.com/api/v10${path}`, {
      headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
    });
    if (!r.ok) throw new Error(`Discord ${r.status} on ${path}`);
    return r.json();
  }

  try {
    const guildId = process.env.DISCORD_GUILD_ID;
    const allRoles = await discordFetch(`/guilds/${guildId}/roles`);
    const roleMap  = {};
    allRoles.forEach(r => roleMap[r.id] = r.name);

    let members = [], after = '0';
    while (true) {
      const batch = await discordFetch(`/guilds/${guildId}/members?limit=1000&after=${after}`);
      members = members.concat(batch);
      if (batch.length < 1000) break;
      after = batch[batch.length - 1].user.id;
    }

    // COACH CAP: each coach's preserved cap value lives in the separate
    // 'coaches' Redis hash (see sync.js/admin.js) so it survives the
    // player→coach transition unchanged. Merge it in here by Discord ID —
    // entirely independent of the player salary cap system.
    const coachCapRaw = await redis.hgetall('coaches') || {};
    const coachCapById = {};
    for (const [k, v] of Object.entries(coachCapRaw)) {
      const val = typeof v === 'string' ? JSON.parse(v) : v;
      if (val && typeof val.cap === 'number') coachCapById[k] = val.cap;
    }

    const owners  = [];
    const coaches = [];

    for (const member of members) {
      if (member.user?.bot) continue;
      const roleNames = (member.roles || []).map(id => roleMap[id]).filter(Boolean);

      const isOwner = roleNames.includes(FRANCHISE_OWNER_ROLE);
      const isCoach = roleNames.includes(TEAM_COACH_ROLE);
      if (!isOwner && !isCoach) continue;

      let team = null;
      for (const rn of roleNames) {
        const m = rn.match(/^\[([A-Z]+)\]/);
        if (m && ROLE_TO_TEAM[m[1]]) { team = ROLE_TO_TEAM[m[1]]; break; }
      }

      // Only expose display name and team — no Discord IDs or avatar URLs
      // Always use the Discord username (not the server nickname)
      const entry = {
        name: member.user.username,
        nick: member.user.username,
        team,
      };

      if (isOwner) owners.push(entry);
      if (isCoach) {
        // cap is null if this coach hasn't synced into the 'coaches' hash
        // yet (e.g. Discord roles changed but /api/sync hasn't run since).
        const cap = coachCapById[member.user.id];
        coaches.push({ ...entry, cap: typeof cap === 'number' ? cap : null });
      }
    }

    owners.sort( (a,b) => (a.team||'zzz').localeCompare(b.team||'zzz') || a.name.localeCompare(b.name));
    coaches.sort((a,b) => (a.team||'zzz').localeCompare(b.team||'zzz') || a.name.localeCompare(b.name));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.json({ owners, coaches });
  } catch (err) {
    console.error('Staff fetch error:', err);
    return res.status(500).json({ error: err.message });
  }
}
