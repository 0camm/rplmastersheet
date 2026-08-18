// api/_lib/audit-log.js — shared audit log storage
//
// Every mutating admin action gets appended here as a single JSON record.
// Stored as a Redis list ('auditlog'), newest entry first (LPUSH), trimmed
// to AUDIT_LOG_MAX entries so it can't grow without bound. This is a plain
// history log, not a source of truth for anything else the app reads.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const AUDIT_LOG_KEY = 'auditlog';
const AUDIT_LOG_MAX = 500;

/**
 * Record one admin action.
 * @param {object} entry
 * @param {string} entry.actor    - who performed the action (display name/tag)
 * @param {string} entry.action   - short machine-ish label, e.g. "Set Salary"
 * @param {string} entry.target   - who/what was affected, e.g. a player name
 * @param {string} [entry.details] - human-readable summary of the change
 */
export async function logAudit({ actor, action, target, details }) {
  try {
    const record = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      actor: actor && String(actor).trim() ? String(actor).trim().slice(0, 60) : 'Unknown admin',
      action: action || 'Unknown action',
      target: target || '—',
      details: details || '',
    };
    await redis.lpush(AUDIT_LOG_KEY, JSON.stringify(record));
    await redis.ltrim(AUDIT_LOG_KEY, 0, AUDIT_LOG_MAX - 1);
    return record;
  } catch (err) {
    // Audit logging should never take down the action it's logging.
    console.error('Audit log write failed:', err);
    return null;
  }
}

export async function getAuditLog(limit = 200) {
  const capped = Math.max(1, Math.min(Number(limit) || 200, AUDIT_LOG_MAX));
  const raw = await redis.lrange(AUDIT_LOG_KEY, 0, capped - 1);
  return (raw || []).map(v => (typeof v === 'string' ? JSON.parse(v) : v));
}
