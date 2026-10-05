// The student-email bonus line is a promise: Home's nudge, the Account row and
// the link sheet all say "Get N community points" whenever GET
// /api/me/student-email carries a bonus. It used to carry one whenever a
// signup program was live, which promised points to students payLinkBonus()
// would refuse (already paid once, a clawed-back grant, an exhausted budget).
// These tests pin signupBonusPayable() to the payout's real rules.
//
// The fake PostgREST below EVALUATES the filter the query sends against an
// in-memory community_grants table, instead of answering a canned count, so a
// filter that does not mean what its comment says fails here.

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { signupBonusPayable, studentEmailState } from '../src/lib/student-email.js';

const STUDENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = 'abababab-cdcd-4efe-8aba-cdcdcdcdcdcd';
const PROGRAM = {
  id: 'cacacaca-dbdb-4ecf-8fab-cdcdcdcdcdcd', name: 'PSU email signup bonus', active: true,
  starts_at: null, ends_at: null, budget_points: null, spent_points: 0,
  config: { points: 50, domains: ['psu.edu'] },
};

/* ---------- a fake PostgREST with just enough filter grammar ---------- */

const realFetch = globalThis.fetch;
let grants = [];          // community_grants rows
let program = PROGRAM;    // the active signup_domain incentive, or null
let grantsStatus = 200;   // to simulate a failing read
let calls = [];

// Split "a,b(c,d),e" on the commas that are not inside parentheses.
function splitTop(s) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// One PostgREST condition: and(...), or(...), col.eq.val, col.is.null.
function matches(row, cond) {
  const group = /^(and|or)\((.*)\)$/.exec(cond);
  if (group) {
    const parts = splitTop(group[2]);
    return group[1] === 'and' ? parts.every((p) => matches(row, p)) : parts.some((p) => matches(row, p));
  }
  const [col, op, ...rest] = cond.split('.');
  const val = rest.join('.');
  if (op === 'eq') return String(row[col]) === val;
  if (op === 'is' && val === 'null') return row[col] == null;
  throw new Error(`fake PostgREST: unsupported condition ${cond}`);
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname !== 'unit-test-placeholder.invalid') return realFetch(input, init);
  const path = url.pathname.replace(/^\/rest\/v1\//, '');
  const method = String(init.method ?? 'GET').toUpperCase();
  calls.push({ path, method, params: url.searchParams });
  const json = (data, status = 200, headers = {}) =>
    new Response(method === 'HEAD' ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

  if (path === 'incentives') return json(program ? [program] : []);
  if (path === 'community_grants') {
    if (grantsStatus !== 200) return json({ message: 'boom' }, grantsStatus);
    let rows = grants;
    for (const [k, v] of url.searchParams) {
      if (k === 'select') continue;
      if (k === 'or') rows = rows.filter((r) => matches(r, `or${v}`));
      else rows = rows.filter((r) => matches(r, `${k}.${v}`));
    }
    return json([], 200, { 'content-range': `*/${rows.length}` });
  }
  return json({ code: 'PGRST205', message: `no table ${path}` }, 404);
};

after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { grants = []; program = PROGRAM; grantsStatus = 200; calls = []; });

const grant = (over) => ({ user_id: STUDENT, ref_id: STUDENT, kind: 'signup_domain', voided_at: null, ...over });

/* ---------- signupBonusPayable ---------- */

test('a student with no signup grant, under a live uncapped program, would be paid', async () => {
  assert.equal(await signupBonusPayable(STUDENT, PROGRAM), true);
});

test('a student already holding the bonus is not promised it again', async () => {
  grants = [grant()];
  assert.equal(await signupBonusPayable(STUDENT, PROGRAM), false);
});

test('a bonus that arrived with a MERGE counts too (user_id is ours, ref_id is not)', async () => {
  grants = [grant({ ref_id: OTHER })];
  assert.equal(await signupBonusPayable(STUDENT, PROGRAM), false);
});

test('a clawed-back grant still blocks it: the unique key ignores voided_at, so the payout would refuse', async () => {
  grants = [grant({ voided_at: '2026-09-20T00:00:00Z' })];
  assert.equal(await signupBonusPayable(STUDENT, PROGRAM), false);
});

test('a voided grant that merely moved here from another student does not block it', async () => {
  // Same exclusion payLinkBonus makes (voided_at is null on the user_id side),
  // and the ref_id key is someone else's, so the RPC would pay.
  grants = [grant({ ref_id: OTHER, voided_at: '2026-09-20T00:00:00Z' })];
  assert.equal(await signupBonusPayable(STUDENT, PROGRAM), true);
});

test("other students' grants and other kinds of grant are irrelevant", async () => {
  grants = [
    grant({ user_id: OTHER, ref_id: OTHER }),
    grant({ kind: 'referral', ref_id: 'r-1' }),
  ];
  assert.equal(await signupBonusPayable(STUDENT, PROGRAM), true);
});

test('the budget uses the payout\'s own test: spent + points <= budget', async () => {
  const at = (spent) => ({ ...PROGRAM, budget_points: 100, spent_points: spent });
  assert.equal(await signupBonusPayable(STUDENT, at(50)), true, 'exactly enough budget pays');
  assert.equal(await signupBonusPayable(STUDENT, at(51)), false, 'one point short does not');
  assert.equal(await signupBonusPayable(STUDENT, { ...PROGRAM, budget_points: null, spent_points: 9e6 }), true, 'null budget is uncapped');
});

test('a program paying nothing promises nothing; a config without points uses the default', async () => {
  assert.equal(await signupBonusPayable(STUDENT, { ...PROGRAM, config: { points: 0 } }), false);
  assert.equal(await signupBonusPayable(STUDENT, { ...PROGRAM, config: {} }), true);
});

test('no program, or an id that is not a UUID, answers no without reading anything', async () => {
  assert.equal(await signupBonusPayable(STUDENT, null), false);
  assert.equal(await signupBonusPayable('x),ref_id.eq.y', PROGRAM), false);
  assert.equal(await signupBonusPayable(undefined, PROGRAM), false);
  assert.equal(calls.length, 0);
});

test('a failed read throws rather than guessing', async () => {
  grantsStatus = 500;
  await assert.rejects(() => signupBonusPayable(STUDENT, PROGRAM));
});

/* ---------- what GET /api/me/student-email carries ---------- */

const user = { id: STUDENT, email: 'someone@gmail.com' };

test('the status names the bonus only when it would be paid', async () => {
  assert.deepEqual((await studentEmailState(user, {})).bonus, { points: 50 });
  grants = [grant()];
  assert.equal((await studentEmailState(user, {})).bonus, null);
});

test('an exhausted budget drops the bonus line from the status', async () => {
  program = { ...PROGRAM, budget_points: 500, spent_points: 480 };
  assert.equal((await studentEmailState(user, {})).bonus, null);
});

test('no live program: no bonus, and the grants table is never read', async () => {
  program = null;
  assert.equal((await studentEmailState(user, {})).bonus, null);
  assert.equal(calls.filter((c) => c.path === 'community_grants').length, 0);
});

test('a read error drops the promise but never fails the status', async () => {
  grantsStatus = 500;
  const s = await studentEmailState(user, {});
  assert.equal(s.bonus, null);
  assert.equal(typeof s.eligible, 'boolean');
});
