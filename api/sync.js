// api/sync.js — called by Vercel Cron, syncs Discord roles → player teams
import { Redis } from '@upstash/redis';
import { ROLE_TO_TEAM } from './_lib/discord-teams.js';
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});
async function discordFetch(path, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
    });
    if (res.status === 429 && attempt < retries) {
      // Discord rate limit — respect Retry-After (seconds) and try again
      // instead of aborting the whole sync. With ~1300 members this hits
      // fairly often during pagination.
      const body = await res.json().catch(() => ({}));
      const waitMs = Math.ceil((body.retry_after ?? 1) * 1000) + 50;
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) throw new Error(`Discord ${res.status} on ${path}: ${await res.text()}`);
    return res.json();
  }
  throw new Error(`Discord rate limit exceeded retries on ${path}`);
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

  // FIX: declared outside the try block so the catch handler can still
  // report accurate partial-progress counts if something throws mid-run.
  let totalWritten = 0;

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

    // COACH CAP: separate Redis hash that holds preserved cap values for
    // members who are (or have been) Team Coaches. A coach's cap is never
    // reset when they leave the 'players' hash — it's carried over here
    // once, on the transition, and left untouched after that. This hash is
    // read by /api/staff (merged into each coach's entry) and totalled
    // per-team on the frontend against the separate $30M Coach Salary Cap.
    // Entirely independent of the player salary cap system.
    const existingCoaches = await redis.hgetall('coaches') || {};

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

    let updated = 0, added = 0, removed = 0, coachesPreserved = 0;
    const entries = {};
    const coachEntries = {};
    const toDelete = [];
    const CHUNK_SIZE = 200; // flush to Redis every N processed members

    for (const member of members) {
      if (member.user?.bot) continue;

      const roleNames = (member.roles || []).map(id => roleMap[id]).filter(Boolean);
      const isCoach = roleNames.includes('Team Coaches');
      const userId = member.user.id;

      if (isCoach) {
        // FIX: use toLowerCase() consistently — the index is keyed by lowercase
        const usernameLower = member.user.username.toLowerCase();

        // Team tag, resolved the same way as for players, so coach cap can
        // be grouped/totaled per team just like player salary is.
        let coachTeam = null;
        for (const roleId of (member.roles || [])) {
          const match = (roleMap[roleId] || '').match(/^\[([A-Z]+)\]/);
          if (match && ROLE_TO_TEAM[match[1]]) { coachTeam = ROLE_TO_TEAM[match[1]]; break; }
        }

        const existingCoachRaw = existingCoaches[userId];
        const existingCoach = existingCoachRaw
          ? (typeof existingCoachRaw === 'string' ? JSON.parse(existingCoachRaw) : existingCoachRaw)
          : null;

        if (existingCoach) {
          // Already a tracked coach — their cap was preserved once already;
          // never touch it again. Only refresh name/team if they've changed.
          if (existingCoach.team !== coachTeam || existingCoach.name !== member.user.username) {
            coachEntries[userId] = { ...existingCoach, name: member.user.username, team: coachTeam };
          }
        } else {
          // First time we see this member as a coach: carry over their
          // existing player cap unchanged instead of resetting/dropping it.
          // Falls back to the standard default only if they never had a
          // player cap record at all (e.g. joined straight into coaching).
          const prevByIdRaw = existing[userId];
          const prevById = prevByIdRaw ? (typeof prevByIdRaw === 'string' ? JSON.parse(prevByIdRaw) : prevByIdRaw) : null;
          const prevByName = legacyByName[usernameLower];
          const preservedCap = prevById?.salary ?? prevByName?.salary ?? 2000000;
          coachEntries[userId] = { id: userId, name: member.user.username, team: coachTeam, cap: preservedCap };
          coachesPreserved++;
        }

        if (existing[userId]) { toDelete.push(userId); removed++; }
        const leg = legacyByName[usernameLower];
        if (leg && !toDelete.includes(leg.key)) { toDelete.push(leg.key); }

        if (Object.keys(coachEntries).length >= CHUNK_SIZE) {
          await redis.hset('coaches', coachEntries);
          for (const k of Object.keys(coachEntries)) delete coachEntries[k];
        }
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
      totalWritten++;

      // FIX: flush to Redis every CHUNK_SIZE members instead of holding
      // everything in memory for one giant write at the very end. With
      // ~1300 members, any single failure late in the run (Discord rate
      // limit, a Vercel timeout, a network blip) used to throw away every
      // successful match from the entire run because nothing was saved
      // until the last line. Now already-processed members survive even
      // if a later batch fails.
      if (Object.keys(entries).length >= CHUNK_SIZE) {
        await redis.hset('players', entries);
        for (const k of Object.keys(entries)) delete entries[k];
      }
      if (toDelete.length >= CHUNK_SIZE) {
        await redis.hdel('players', ...toDelete.splice(0, toDelete.length));
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
    if (Object.keys(coachEntries).length > 0) {
      await redis.hset('coaches', coachEntries);
    }
    // FIX: hdel with a huge spread of args (1000+) can hit request-size
    // limits — delete in chunks instead of one call.
    while (toDelete.length > 0) {
      await redis.hdel('players', ...toDelete.splice(0, CHUNK_SIZE));
    }

    return res.json({
      ok: true,
      message: `Sync complete — ${added} added, ${updated} updated, ${removed} staff removed (${coachesPreserved} new coach cap${coachesPreserved === 1 ? '' : 's'} preserved), ${left} left-server entries removed, ${totalWritten} total`
    });
  } catch (err) {
    console.error('Sync error:', err);
    // FIX: report partial progress instead of just dying silently — if this
    // fires mid-run, everything up through the last CHUNK_SIZE flush is
    // already safely saved in Redis, so the next sync run picks up from there.
    return res.status(500).json({ error: `${err.message} (partial progress saved: ${totalWritten} players written before failure)` });
  }
}
