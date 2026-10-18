// Every admin dialog has a ✕ in its top-right corner, and it closes the dialog
// the same way that dialog's backdrop does. Source-text checks, like the other
// admin client tests: the dashboard has no DOM in the test run, and what can
// rot here is the wiring — a new .overlay added to index.html without its
// button, or a button whose id never made it into admin.js's MODAL_X table,
// renders an X that does nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../public/admin/admin.js', import.meta.url), 'utf8');

const overlayIds = [...html.matchAll(/<div id="([a-z0-9-]+)" class="overlay"/g)].map((m) => m[1]);
const table = js.slice(js.indexOf('const MODAL_X = {'), js.indexOf('};', js.indexOf('const MODAL_X = {')));
const wired = Object.fromEntries([...table.matchAll(/'([a-z0-9-]+)': ([A-Za-z]+),/g)].map((m) => [m[1], m[2]]));

test('there are dialogs to check (the pattern still matches the markup)', () => {
  assert.ok(overlayIds.length >= 8, `found ${overlayIds.length}`);
});

test('every dialog card opens with a ✕ button', () => {
  for (const id of overlayIds) {
    const start = html.indexOf(`<div id="${id}" class="overlay"`);
    const head = html.slice(start, html.indexOf('\n', html.indexOf('role="dialog"', start) + 1) + 200);
    assert.match(head, /<button class="modal-x" type="button" aria-label="Close">✕<\/button>/, id);
  }
});

test('every dialog is in MODAL_X, and nothing else is', () => {
  assert.deepEqual(Object.keys(wired).sort(), [...overlayIds].sort());
});

test('each X calls a close function that exists', () => {
  for (const [id, fn] of Object.entries(wired)) {
    assert.ok(new RegExp(`\\nfunction ${fn}\\(`).test(js), `${id} → ${fn} is not defined in admin.js`);
  }
});

test('the alerts card X is "Not now", the same as its backdrop', () => {
  assert.equal(wired['push-modal'], 'dismissPushModal');
});
