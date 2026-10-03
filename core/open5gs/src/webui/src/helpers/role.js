import Session from 'modules/auth/session';

/* 3-tier RBAC helper (client-side affordances only - the server
 * enforces the real policy). viewer < operator < admin.
 * Legacy 'user' maps to operator. */
const RANK = { viewer: 1, user: 2, operator: 2, admin: 3 };

export function getRank() {
  if (typeof window === 'undefined') return 0;
  const s = new Session();
  const roles = (((s || {}).session || {}).user || {}).roles || [];
  let r = 0;
  roles.forEach(x => { if ((RANK[x] || 0) > r) r = RANK[x] || 0; });
  return r;
}

export const isAdmin = () => getRank() >= 3;
export const isOperator = () => getRank() >= 2;
