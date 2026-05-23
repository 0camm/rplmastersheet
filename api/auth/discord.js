export default function handler(req, res) {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.members.read',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
}
