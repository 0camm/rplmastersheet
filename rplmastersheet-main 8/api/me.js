// api/me.js — returns the logged-in user's name and team from their session cookie.
// Replaces the old pattern of passing name/team in redirect query params.
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/rpl_session=([^;]+)/);
  if (!match) return res.status(401).json({ error: 'Not logged in' });

  const sessionToken = match[1];
  // Basic format validation to avoid unnecessary Redis lookups
  if (!/^[0-9a-f-]{36}$/.test(sessionToken)) return res.status(401).json({ error: 'Invalid session' });

  try {
    const raw = await redis.get(`session:${sessionToken}`);
    if (!raw) return res.status(401).json({ error: 'Session expired' });
    const { name, team } = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return res.json({ name, team });
  } catch (err) {
    console.error('Session lookup error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
