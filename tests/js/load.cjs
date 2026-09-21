'use strict';
/* Ordered loader for the split Desk client. hooks.py's app_include_js must
   list the same files in the same order. */
const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '../../frappe_intelligence/public/js');
const FILES = ['intelligence.js', 'fi/store.js', 'fi/thread.js', 'fi/composer.js', 'fi/panel.js', 'fi/desk_compat.js', 'fi/app.js'];
function source() {
  return FILES.map((file) => fs.readFileSync(path.join(dir, file), 'utf8')).join('\n');
}
function load() {
  const client = require(path.join(dir, 'intelligence.js'));
  for (const file of FILES.slice(1)) require(path.join(dir, file));
  return client;
}
module.exports = { FILES, source, load };
