// api/staff.js — returns Franchise Owners and Team Coaches from Discord
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const FRANCHISE_OWNER_ROLE = 'Franchise Owners';
  const TEAM_COACH_ROLE      = 'Team Coaches';

  const ROLE_TO_TEAM = {
    'ATL':'Atlanta Hawks','BKN':'Brooklyn Nets','BOS':'Boston Celtics',
    'CHI':'Chicago Bulls','CLE':'Cleveland Cavaliers','CHA':'Charlotte Hornets',
    'DAL':'Dallas Mavericks','DEN':'Denver Nuggets','DET':'Detroit Pistons',
    'GSW':'Golden State Warriors','HOU':'Houston Rockets','IND':'Indiana Pacers',
    'LAC':'LA Clippers','LAL':'Los Angeles Lakers','MIA':'Miami Heat',
    'MIL':'Milwaukee Bucks','MEM':'Memphis Grizzlies','MIN':'Minnesota Timberwolves',
    'NOP':'New Orleans Pelicans','NYK':'New York Knicks','OKC':'Oklahoma City Thunder',
    'ORL':'Orlando Magic','PHI':'Philadelphia 76ers','PHX':'Phoenix Suns',
    'POR':'Portland Trail Blazers','SAC':'Sacramento Kings','SAN':'San Antonio Spurs',
    'TOR':'Toronto Raptors','UTA':'Utah Jazz','WAS':'Washington Wizards',
  };

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

    // Paginate through all guild members
    let members = [], after = '0';
    while (true) {
      const batch = await discordFetch(`/guilds/${guildId}/members?limit=1000&after=${after}`);
      members = members.concat(batch);
      if (batch.length < 1000) break;
      after = batch[batch.length - 1].user.id;
    }

    const owners  = [];
    const coaches = [];

    for (const member of members) {
      if (member.user?.bot) continue;
      const roleNames = (member.roles || []).map(id => roleMap[id]).filter(Boolean);

      const isOwner  = roleNames.includes(FRANCHISE_OWNER_ROLE);
      const isCoach  = roleNames.includes(TEAM_COACH_ROLE);
      if (!isOwner && !isCoach) continue;

      // Resolve team from [ABC] role
      let team = null;
      for (const rn of roleNames) {
        const m = rn.match(/^\[([A-Z]+)\]/);
        if (m && ROLE_TO_TEAM[m[1]]) { team = ROLE_TO_TEAM[m[1]]; break; }
      }

      const entry = {
        id:     member.user.id,
        name:   member.user.username,
        nick:   member.user.username,
        avatar: member.user.avatar
          ? `https://cdn.discordapp.com/avatars/${member.user.id}/${member.user.avatar}.webp?size=64`
          : `https://cdn.discordapp.com/embed/avatars/${Number(member.user.discriminator || 0) % 5}.png`,
        team,
      };

      if (isOwner)  owners.push(entry);
      if (isCoach)  coaches.push(entry);
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
