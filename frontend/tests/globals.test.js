const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The page loads plain scripts that share one global scope, so a top-level const/let/class that another
// script already declared is a SyntaxError that drops the whole later script (e.g. every Battery page
// renderer). `node --check` checks each file alone and cannot see it; this loads them together.
test('page scripts can share one global scope', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*\ssrc="\.\/([^"?]+)[^"]*"/g)].map((m) => m[1]);
  assert.ok(scripts.length > 5, 'found the page scripts');
  const context = vm.createContext({});
  for (const file of scripts) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    try {
      new vm.Script(source, { filename: file }).runInContext(context);
    } catch (error) {
      // Without a DOM most scripts stop at their first browser call. Their globals are declared before
      // any code runs, so only a redeclaration matters here.
      if (/has already been declared/.test(String(error && error.message))) assert.fail(`${file}: ${error.message}`);
    }
  }
});
