/**
 * Convert array of objects to CSV string.
 * @param {Array} data - Array of row objects
 * @param {Array} columns - Array of { key, label, accessor? }
 * @returns {string}
 */
export function toCSV(data, columns) {
  var header = columns.map(function(c) {
    return '"' + String(c.label).replace(/"/g, '""') + '"';
  }).join(',');

  var rows = data.map(function(row) {
    return columns.map(function(c) {
      var val;
      if (typeof c.accessor === 'function') {
        val = c.accessor(row);
      } else {
        val = row[c.key] != null ? String(row[c.key]) : '';
      }
      return '"' + String(val).replace(/"/g, '""') + '"';
    }).join(',');
  });

  return header + '\n' + rows.join('\n');
}

/**
 * Trigger a file download in the browser.
 */
export function downloadFile(content, filename, mimeType) {
  var blob = new Blob([content], { type: mimeType });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export data as CSV file.
 */
export function exportCSV(data, columns, filename) {
  var csv = toCSV(data, columns);
  downloadFile(csv, filename || 'export.csv', 'text/csv;charset=utf-8;');
}

/**
 * Export data as JSON file.
 */
export function exportJSON(data, filename) {
  var json = JSON.stringify(data, null, 2);
  downloadFile(json, filename || 'export.json', 'application/json;charset=utf-8;');
}
