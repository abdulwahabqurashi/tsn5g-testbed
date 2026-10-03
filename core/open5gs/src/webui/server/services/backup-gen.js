/*
 * Full-state backup & restore.
 * Bundles the deployment's persistent state into one JSON document:
 * subscribers, profiles, WebUI accounts, alert config, and the TSN-AF
 * bridge persistence file. Restore upserts each collection back.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const Subscriber = require('../models/subscriber');
const Profile = require('../models/profile');
const Account = require('../models/account');
const AlertConfig = require('../models/alert-config');

const BACKUP_DIR = process.env.BACKUP_DIR ||
    path.join(__dirname, '../../../build/backups');
const BRIDGE_FILE = process.env.TSN_BRIDGE_FILE ||
    '/var/lib/open5gs/tsn-af-bridges.json';

const COLLECTIONS = {
  subscribers: Subscriber,
  profiles: Profile,
  accounts: Account,
  alertconfigs: AlertConfig
};

function ensureDir() {
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) {}
}

async function exportBundle() {
  const bundle = {
    format: 'amrc-5gtsn-backup',
    version: 1,
    created: new Date().toISOString(),
    collections: {}
  };
  for (const name of Object.keys(COLLECTIONS)) {
    try {
      bundle.collections[name] = await COLLECTIONS[name].find({}).lean().exec();
    } catch (e) { bundle.collections[name] = []; }
  }
  /* TSN-AF bridge persistence file (managed outside Mongo) */
  try {
    bundle.tsn_af_bridges = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
  } catch (e) { bundle.tsn_af_bridges = null; }
  return bundle;
}

/* restore: upsert each doc by its _id. options.collections limits scope. */
async function importBundle(bundle, options) {
  options = options || {};
  if (!bundle || bundle.format !== 'amrc-5gtsn-backup')
    throw new Error('not a valid backup bundle');
  const only = options.collections; /* array of names, or undefined = all */
  const report = {};

  for (const name of Object.keys(COLLECTIONS)) {
    if (only && only.indexOf(name) < 0) continue;
    const docs = (bundle.collections || {})[name] || [];
    const Model = COLLECTIONS[name];
    let n = 0;
    for (const doc of docs) {
      try {
        const id = doc._id;
        const copy = Object.assign({}, doc);
        delete copy.__v;
        if (id) {
          await Model.updateOne({ _id: id }, copy, { upsert: true });
        } else {
          await Model.create(copy);
        }
        n++;
      } catch (e) { /* skip individual doc errors */ }
    }
    report[name] = n;
  }

  /* restore bridge file if present and requested */
  if (bundle.tsn_af_bridges && (!only || only.indexOf('tsn_af_bridges') >= 0)) {
    try {
      fs.mkdirSync(path.dirname(BRIDGE_FILE), { recursive: true });
      fs.writeFileSync(BRIDGE_FILE, JSON.stringify(bundle.tsn_af_bridges, null, 2));
      report.tsn_af_bridges = 1;
    } catch (e) { report.tsn_af_bridges = 0; }
  }
  return report;
}

async function generateScheduled() {
  ensureDir();
  try {
    const bundle = await exportBundle();
    const stamp = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(BACKUP_DIR, 'backup-' + stamp + '.json'),
      JSON.stringify(bundle));
    /* keep only the 14 most recent scheduled backups */
    const files = listBackups();
    files.slice(14).forEach(f => {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch (e) {}
    });
  } catch (e) { /* skip */ }
}

function listBackups() {
  ensureDir();
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) { return []; }
}

function readBackup(name) {
  if (!/^[\w.\-]+\.json$/.test(name)) return null;
  try { return fs.readFileSync(path.join(BACKUP_DIR, name)); }
  catch (e) { return null; }
}

module.exports = {
  exportBundle, importBundle, generateScheduled, listBackups, readBackup,
  BACKUP_DIR
};
