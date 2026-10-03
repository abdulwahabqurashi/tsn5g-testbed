const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || '/var/local/log/open5gs';

// Known service names
const KNOWN_SERVICES = [
  'amf', 'smf', 'upf', 'nrf', 'scp', 'pcf', 'udm', 'udr',
  'ausf', 'nssf', 'bsf', 'tsn-af', 'webui'
];

// GET /api/logs/list - list available log files
router.get('/list', function(req, res) {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      return res.json([]);
    }
    var files = fs.readdirSync(LOG_DIR);
    var result = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f.endsWith('.log')) continue;
      var name = f.replace('.log', '');
      var filePath = path.join(LOG_DIR, f);
      try {
        var stats = fs.statSync(filePath);
        result.push({
          name: name,
          file: f,
          size: stats.size,
          modified: stats.mtime
        });
      } catch (e) {
        // skip files we can't stat
      }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list log files' });
  }
});

// GET /api/logs/:service - get last N lines of a service log
router.get('/:service', function(req, res) {
  var service = req.params.service;

  // Sanitize service name - only allow alphanumeric, dash, underscore
  if (!/^[a-zA-Z0-9_-]+$/.test(service)) {
    return res.status(400).json({ error: 'Invalid service name' });
  }

  var lines = parseInt(req.query.lines) || 200;
  if (lines > 1000) lines = 1000;
  if (lines < 1) lines = 1;

  var filePath = path.join(LOG_DIR, service + '.log');

  // Prevent path traversal
  var resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(LOG_DIR))) {
    return res.status(400).json({ error: 'Invalid service name' });
  }

  try {
    if (!fs.existsSync(filePath)) {
      return res.json([]);
    }

    var content = fs.readFileSync(filePath, 'utf8');
    var allLines = content.split('\n');
    // Remove trailing empty line
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }
    // Return last N lines
    var result = allLines.slice(-lines);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read log file' });
  }
});

module.exports = router;
