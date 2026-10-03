/*
 * Parse a gNB PM upload into { kpis, meta }.
 * Handles the 3GPP TS 32.435 / 28.552 measData XML shape and a
 * generic CSV fallback. Dependency-free (regex extraction) so it works
 * without an XML library; tolerant of vendor variations.
 */

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[, ]/g, ''));
  return isNaN(n) ? null : n;
}

/* 3GPP measData XML:
 *   <measType p="1">RRC.ConnEstabAtt</measType> ...
 *   <measValue measObjLdn="..."><r p="1">42</r> ...</measValue>
 *   <granularityPeriod duration="PT900S" endTime="..."/>
 *   <measCollec beginTime="..."/>
 */
function parseXML(text) {
  const kpis = {};
  const meta = {};

  /* map measType index -> KPI name */
  const types = {};
  let m;
  const typeRe = /<measType[^>]*\bp=["'](\d+)["'][^>]*>([\s\S]*?)<\/measType>/gi;
  while ((m = typeRe.exec(text))) types[m[1]] = m[2].trim();

  /* first measValue block's r elements -> values by index */
  const valBlock = text.match(/<measValue\b([^>]*)>([\s\S]*?)<\/measValue>/i);
  if (valBlock) {
    const attrs = valBlock[1] || '';
    const ldn = attrs.match(/measObjLdn=["']([^"']+)["']/i);
    if (ldn) meta.object_ldn = ldn[1];
    const rRe = /<r[^>]*\bp=["'](\d+)["'][^>]*>([\s\S]*?)<\/r>/gi;
    let rm;
    while ((rm = rRe.exec(valBlock[2]))) {
      const name = types[rm[1]];
      const v = num(rm[2]);
      if (name && v != null) kpis[name] = v;
    }
  }

  /* granularity + period */
  const gp = text.match(/duration=["']PT(\d+)S["']/i);
  if (gp) meta.granularity_s = parseInt(gp[1], 10);
  const end = text.match(/endTime=["']([^"']+)["']/i);
  if (end) meta.period_end = end[1];
  const beg = text.match(/beginTime=["']([^"']+)["']/i);
  if (beg) meta.period_start = beg[1];
  const gid = text.match(/(?:gnb[_-]?id|managedElement)["'>=\s]+([A-Za-z0-9_-]+)/i);
  if (gid) meta.gnb_id = gid[1];

  return { kpis, meta };
}

/* generic CSV: header row of names, one or more data rows of numbers */
function parseCSV(text) {
  const kpis = {};
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (lines.length < 2) return { kpis, meta: {} };
  const head = lines[0].split(',').map(h => h.trim());
  const row = lines[1].split(',').map(c => c.trim());
  head.forEach((h, i) => {
    const v = num(row[i]);
    if (h && v != null) kpis[h] = v;
  });
  return { kpis, meta: {} };
}

function parse(text) {
  if (!text || !text.trim()) return { kpis: {}, meta: {} };
  const t = text.trim();
  let out;
  if (t[0] === '<' || /measType|measData|measCollec/i.test(t)) out = parseXML(t);
  else if (t.indexOf(',') >= 0) out = parseCSV(t);
  else out = { kpis: {}, meta: {} };
  return out;
}

module.exports = { parse };
