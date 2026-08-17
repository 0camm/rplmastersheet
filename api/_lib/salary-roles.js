// api/_lib/salary-roles.js
// Shared source of truth for how a player's salary maps to a Discord
// "salary bracket" role. Mirrors the SALARY_STEPS ladder used on the site
// (index.html) so the bracket shown on the sheet is the bracket the bot
// tags them with in Discord.
//
// EDIT ME: the `role` values below must match your actual Discord role
// names EXACTLY (case-sensitive, no extra spaces). If your server uses
// something like "Tier 1".."Tier 9" or "$2,000,000" instead of "$2M",
// change the strings below — nothing else needs to change.
export const SALARY_BRACKETS = [
  { amount: 2000000,  role: '$2M'  },
  { amount: 5000000,  role: '$5M'  },
  { amount: 8000000,  role: '$8M'  },
  { amount: 10000000, role: '$10M' },
  { amount: 12000000, role: '$12M' },
  { amount: 15000000, role: '$15M' },
  { amount: 18000000, role: '$18M' },
  { amount: 20000000, role: '$20M' },
  { amount: 22000000, role: '$22M' },
];

// Same "nearest step" logic as index.html's nearestStepIndex(), so a salary
// that's slightly off the ladder (e.g. from a legacy import) still resolves
// to the closest bracket instead of matching nothing.
export function salaryToRoleName(salary) {
  let best = SALARY_BRACKETS[0];
  let bestDist = Infinity;
  for (const b of SALARY_BRACKETS) {
    const dist = Math.abs(b.amount - salary);
    if (dist < bestDist) { bestDist = dist; best = b; }
  }
  return best.role;
}

// Every role name this module knows about — used to find and strip
// whichever bracket role a member currently holds before adding the new one.
export const ALL_SALARY_ROLE_NAMES = SALARY_BRACKETS.map(b => b.role);
