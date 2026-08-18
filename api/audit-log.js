// api/audit-log.js — read access to the admin audit log
import { getAuditLog } from './_lib/audit-log.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const { password, limit } = req.body || {};
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  try {
    const entries = await getAuditLog(limit);
    return res.json({ ok: true, entries });
  } catch (err) {
    console.error('Audit log read error:', err);
    return res.status(500).json({ error: err.message });
  }
}
