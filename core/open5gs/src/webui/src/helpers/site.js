/* Active-site client state (localStorage), shared across views.
 * '_all' means no filter. Components listen for 'amrc-site-change'. */
const KEY = 'amrc_active_site';

export function getActiveSite() {
  if (typeof window === 'undefined') return '_all';
  try { return localStorage.getItem(KEY) || '_all'; } catch (e) { return '_all'; }
}

export function setActiveSite(id) {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(KEY, id); } catch (e) {}
  try { window.dispatchEvent(new CustomEvent('amrc-site-change', { detail: id })); } catch (e) {}
}

export function onSiteChange(fn) {
  if (typeof window === 'undefined') return function() {};
  window.addEventListener('amrc-site-change', fn);
  return function() { window.removeEventListener('amrc-site-change', fn); };
}
