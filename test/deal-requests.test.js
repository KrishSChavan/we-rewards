// All-student deal requests (src/lib/deal-requests.js, migration-069).
//
// The SQL half (who an approval reaches, that a request alone reaches nobody,
// that the claim still applies every opt-out) is test/sql/behavior-069.sql.
// This file holds the Node half to the properties that matter most:
//
//   • nothing reaches the database before the input is valid;
//   • a vendor is told their request went to WeRewards for REVIEW, not that
//     anything was sent;
//   • approval is refused while the disclosing Privacy Policy is not live;
//   • only the call that actually changed a request emails the vendor, so a
//     double click or a race between two operators cannot mail twice;
//   • a database without migration-069 answers "not switched on", never a 500.
//
// Supabase is answered by patching globalThis.fetch, the same way
// test/admin-notifications.test.js does it.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  validDealRequest, validNote, everyoneDealsDisclosed, pickRecipient, vendorView,
  submitDealRequest, withdrawDealRequest, listVendorDealRequests, listAdminDealRequests,
  reviewDealRequest, takeDownEveryoneDeal, DEAL_REQUEST_NOTE_MAX,
} from '../src/lib/deal-requests.js';
import { dealRequestDecision } from '../src/lib/email-templates.js';
import { TERMS_VERSION, EVERYONE_DEALS_TERMS_VERSION } from '../src/lib/terms.js';

const VENDOR = { id: 'fafafafa-bcbc-4ded-8efe-abababababab', name: 'Tasty K' };
const STAFF = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OWNER = 'abababab-cdcd-4efe-8aba-cdcdcdcdcdcd';
const ADMIN = 'adadadad-cdcd-4efe-8aba-cdcdcdcdcdcd';
const REQ = 'cacacaca-dbdb-4ecf-8fab-cdcdcdcdcdcd';
const CAMPAIGN = 'bebebebe-adad-4cfc-8bab-dedededededf';

/* ---------- a fake PostgREST ---------- */

const realFetch = globalThis.fetch;
let handlers = {};
let calls = [];

const missingTable = (path) => ({ status: 404, data: { code: 'PGRST205', message: `Could not find the table 'public.${path}' in the schema cache` } });
const missingFn = (path) => ({ status: 404, data: { code: 'PGRST202', message: `Could not find the function public.${path.slice(4)}` } });
const raised = (msg) => ({ status: 400, data: { code: 'P0001', message: msg } });

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname !== 'unit-test-placeholder.invalid') return realFetch(input, init);
  const path = url.pathname.replace(/^\/rest\/v1\//, '');
  const call = {
    method: String(init.method ?? 'GET').toUpperCase(),
    path,
    params: url.searchParams,
    headers: new Headers(init.headers),
    body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
  };
  calls.push(call);
  const h = handlers[path];
  const out = h ? await h(call) : (path.startsWith('rpc/') ? missingFn(path) : missingTable(path));
  const { status = 200, data = [], total } = out ?? {};
  const headers = { 'content-type': 'application/json' };
  if (/count=exact/.test(call.headers.get('prefer') ?? '')) headers['content-range'] = `*/${total ?? (Array.isArray(data) ? data.length : 0)}`;
  if (call.method === 'HEAD') return new Response(null, { status, headers });
  return new Response(JSON.stringify(data), { status, headers });
};

after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { handlers = {}; calls = []; });

const callsTo = (path) => calls.filter((c) => c.path === path);
const tick = () => new Promise((r) => setImmediate(r));

/* ---------- pure helpers ---------- */

describe('validDealRequest', () => {
  test('accepts a valid request and trims it', () => {
    assert.deepEqual(validDealRequest({ title: '  Wings  ', body: ' Half price ', durationHours: 72 }), {
      value: { title: 'Wings', body: 'Half price', durationHours: 72 },
    });
  });

  test('refuses blank, over-long and non-string fields', () => {
    for (const raw of [
      { title: '', body: 'x', durationHours: 72 },
      { title: 'x'.repeat(61), body: 'x', durationHours: 72 },
      { title: 'x', body: '   ', durationHours: 72 },
      { title: 'x', body: 'x'.repeat(141), durationHours: 72 },
      { title: { toString: () => 'x' }, body: 'x', durationHours: 72 },
      { title: 'x', body: ['x'], durationHours: 72 },
    ]) {
      assert.ok(validDealRequest(raw).error, `should refuse ${JSON.stringify(raw)}`);
    }
  });

  test('only the terminal’s own durations are allowed', () => {
    assert.ok(validDealRequest({ title: 'x', body: 'x', durationHours: 5 }).error);
    assert.ok(validDealRequest({ title: 'x', body: 'x', durationHours: 'week' }).error);
    for (const h of [24, 72, 168]) assert.ok(validDealRequest({ title: 'x', body: 'x', durationHours: h }).value);
  });
});

describe('validNote', () => {
  test('blank or absent means no note at all', () => {
    for (const v of [null, undefined, '', '   ']) assert.deepEqual(validNote(v), { note: null });
  });

  test('a note is trimmed and kept', () => {
    assert.deepEqual(validNote('  Say what is half price.  '), { note: 'Say what is half price.' });
  });

  test('over-long, non-string and em-dash notes are refused', () => {
    assert.ok(validNote('x'.repeat(DEAL_REQUEST_NOTE_MAX + 1)).error);
    assert.ok(validNote(42).error);
    assert.ok(validNote('Too vague — say more').error, 'the vendor reads this verbatim, so the house copy rule applies');
  });
});

test('the policy gate opens at the disclosing version and stays open after it', () => {
  assert.equal(everyoneDealsDisclosed(EVERYONE_DEALS_TERMS_VERSION), true);
  assert.equal(everyoneDealsDisclosed('2099-01-01'), true);
  assert.equal(everyoneDealsDisclosed('2026-10-12'), false, 'the documents before this feature do not disclose it');
  assert.equal(everyoneDealsDisclosed(TERMS_VERSION), true, 'this branch ships the disclosure; revert both together');
});

describe('pickRecipient', () => {
  const logins = [
    { user_id: OWNER, email: 'owner@tastyk.test', role: 'owner' },
    { user_id: STAFF, email: 'staff@tastyk.test', role: 'staff' },
  ];
  test('the login that asked hears the answer', () => {
    assert.equal(pickRecipient(logins, STAFF).email, 'staff@tastyk.test');
  });
  test('falls back to an owner when the asker is gone, then to anyone', () => {
    assert.equal(pickRecipient(logins, 'gone').email, 'owner@tastyk.test');
    assert.equal(pickRecipient([{ user_id: STAFF, email: 's@x.test', role: 'staff' }], null).email, 's@x.test');
  });
  test('nobody with an address means nobody', () => {
    assert.equal(pickRecipient([], STAFF), null);
    assert.equal(pickRecipient([{ user_id: STAFF, email: null }], STAFF), null);
  });
});

test('the terminal never sees who reviewed a request', () => {
  const v = vendorView({ id: REQ, title: 't', body: 'b', duration_hours: 72, status: 'denied', admin_note: 'n', reviewed_by: ADMIN, created_at: 'c', reviewed_at: 'r' });
  assert.equal(v.note, 'n');
  assert.ok(!JSON.stringify(v).includes(ADMIN));
});

/* ---------- the decision email ---------- */

describe('dealRequestDecision', () => {
  const base = { businessName: 'Tasty K', title: 'Half-price wings', body: 'Tonight only', durationHours: 72, terminalUrl: 'https://we-rewards.test/terminal/' };

  test('a denial carries the operator’s reason verbatim, escaped in the HTML', () => {
    const m = dealRequestDecision({ ...base, approved: false, note: 'Say <what> is half price' });
    assert.match(m.subject, /wasn’t approved/);
    assert.ok(m.text.includes('Why: Say <what> is half price'));
    assert.ok(m.html.includes('Say &lt;what&gt; is half price'));
    assert.ok(!m.html.includes('<what>'));
    assert.ok(m.text.includes('Nothing was sent to students'));
  });

  test('a denial without a reason points at a mailbox somebody reads', () => {
    const m = dealRequestDecision({ ...base, approved: false, note: '' });
    assert.ok(m.text.includes('contactwerewards@gmail.com'));
  });

  test('an approval says how long it runs and that limits still apply', () => {
    const m = dealRequestDecision({ ...base, approved: true });
    assert.match(m.subject, /^Approved/);
    assert.ok(m.text.includes('runs for 3 days'));
    assert.ok(m.text.includes('doesn\'t use one of your weekly sends'));
    assert.ok(m.text.includes('Half-price wings'));
  });

  test('an approval says when it goes out, quiet hours included', () => {
    const m = dealRequestDecision({ ...base, approved: true, quietStart: 22, quietEnd: 9 });
    assert.ok(m.text.includes('never between 10pm and 9am'), m.text);
    const off = dealRequestDecision({ ...base, approved: true, quietStart: 0, quietEnd: 0 });
    assert.ok(!off.text.includes('never between'), 'quiet hours disabled means no promise about them');
  });

  test('house copy rule: no em dashes in either outcome', () => {
    for (const approved of [true, false]) {
      const m = dealRequestDecision({ ...base, approved, note: 'ok' });
      assert.ok(!`${m.subject}${m.text}${m.html}`.includes('—'), `em dash in the ${approved ? 'approval' : 'denial'}`);
    }
  });
});

/* ---------- the vendor's side ---------- */

describe('submitDealRequest', () => {
  test('an invalid request never reaches the database', async () => {
    const out = await submitDealRequest({ vendor: VENDOR, userId: STAFF, input: { title: '', body: 'x', durationHours: 72 } });
    assert.equal(out.status, 400);
    assert.equal(calls.length, 0);
  });

  test('a valid request is queued and the vendor is told it went for review', async () => {
    handlers['rpc/submit_deal_request'] = (c) => {
      assert.equal(c.body.p_vendor_id, VENDOR.id);
      assert.equal(c.body.p_requested_by, STAFF);
      assert.equal(c.body.p_title, 'Wings');
      assert.equal(c.body.p_duration_hours, 168);
      assert.equal(c.body.p_client_token, 'ev-token-123');
      return { data: [{ out_id: REQ, out_status: 'pending', out_reused: false }] };
    };
    const out = await submitDealRequest({
      vendor: VENDOR, userId: STAFF, requestId: 'ev-token-123',
      input: { title: ' Wings ', body: 'Half price', durationHours: 168 },
    });
    assert.equal(out.status, 201);
    assert.equal(out.body.request.id, REQ);
    assert.match(out.body.message, /sent to WeRewards for review/i);
    assert.match(out.body.message, /email you/i);
  });

  test('a second pending request is a 409 with a sentence, not a 500', async () => {
    handlers['rpc/submit_deal_request'] = () => raised('DEAL_REQUEST_PENDING');
    const out = await submitDealRequest({ vendor: VENDOR, userId: STAFF, input: { title: 'x', body: 'y', durationHours: 72 } });
    assert.equal(out.status, 409);
    assert.equal(out.body.error, 'REQUEST_PENDING');
  });

  test('a switched-off spot gets a sentence', async () => {
    handlers['rpc/submit_deal_request'] = () => raised('VENDOR_UNAVAILABLE');
    const out = await submitDealRequest({ vendor: VENDOR, userId: STAFF, input: { title: 'x', body: 'y', durationHours: 72 } });
    assert.equal(out.status, 409);
  });

  test('without migration-069 it answers "not switched on"', async () => {
    const out = await submitDealRequest({ vendor: VENDOR, userId: STAFF, input: { title: 'x', body: 'y', durationHours: 72 } });
    assert.equal(out.status, 503);
    assert.equal(out.body.error, 'DEAL_REQUESTS_UNAVAILABLE');
  });

  test('a replayed token that finds a closed request is refused, not reported as sent', async () => {
    // The POST landed, the response was lost, the vendor withdrew it, then
    // tapped again with the kept token: the new wording was never stored.
    handlers['rpc/submit_deal_request'] = () => ({ data: [{ out_id: REQ, out_status: 'withdrawn', out_reused: true }] });
    const out = await submitDealRequest({ vendor: VENDOR, userId: STAFF, requestId: 'ev-token-123', input: { title: 'x', body: 'y', durationHours: 72 } });
    assert.equal(out.status, 409);
    assert.equal(out.body.error, 'REQUEST_ALREADY_CLOSED');
    assert.ok(!/for review/i.test(out.body.message));
  });

  test('a replayed token that finds the same pending request is a quiet 200', async () => {
    handlers['rpc/submit_deal_request'] = () => ({ data: [{ out_id: REQ, out_status: 'pending', out_reused: true }] });
    const out = await submitDealRequest({ vendor: VENDOR, userId: STAFF, requestId: 'ev-token-123', input: { title: 'x', body: 'y', durationHours: 72 } });
    assert.equal(out.status, 200);
    assert.equal(out.body.reused, true);
  });

  test('a malformed requestId is dropped rather than stored', async () => {
    let token = 'unset';
    handlers['rpc/submit_deal_request'] = (c) => { token = c.body.p_client_token; return { data: [{ out_id: REQ, out_status: 'pending', out_reused: false }] }; };
    await submitDealRequest({ vendor: VENDOR, userId: STAFF, requestId: 'x', input: { title: 'x', body: 'y', durationHours: 72 } });
    assert.equal(token, null);
  });
});

describe('withdrawDealRequest and the vendor list', () => {
  test('withdrawing scopes the update to this vendor and to an unanswered request', async () => {
    handlers.vendor_deal_requests = (c) => {
      assert.equal(c.method, 'PATCH');
      assert.equal(c.params.get('vendor_id'), `eq.${VENDOR.id}`);
      assert.equal(c.params.get('status'), 'in.(pending,withdrawn)');
      assert.deepEqual(c.body, { status: 'withdrawn' });
      return { data: [{ id: REQ, status: 'withdrawn' }] };
    };
    const out = await withdrawDealRequest(VENDOR.id, REQ);
    assert.equal(out.status, 200);
  });

  test('an already-answered request cannot be withdrawn', async () => {
    handlers.vendor_deal_requests = () => ({ data: [] });
    const out = await withdrawDealRequest(VENDOR.id, REQ);
    assert.equal(out.status, 409);
  });

  test('the terminal list degrades to available:false without the table', async () => {
    const out = await listVendorDealRequests(VENDOR.id);
    assert.equal(out.status, 200);
    assert.equal(out.body.available, false);
  });

  test('the terminal list says whether one is pending', async () => {
    handlers.vendor_deal_requests = () => ({ data: [
      { id: REQ, title: 't', body: 'b', duration_hours: 72, status: 'pending', admin_note: null, created_at: 'c', reviewed_at: null },
    ] });
    const out = await listVendorDealRequests(VENDOR.id);
    assert.equal(out.body.pending, true);
    assert.equal(out.body.requests[0].status, 'pending');
  });
});

/* ---------- the operator's side ---------- */

function reviewWorld({ status = 'denied', changed = true } = {}) {
  handlers['rpc/review_deal_request'] = () => ({ data: [{
    out_status: status, out_changed: changed, out_campaign_id: status === 'approved' ? CAMPAIGN : null,
    out_queued: status === 'approved' ? 87 : null, out_vendor_id: VENDOR.id, out_requested_by: STAFF,
  }] });
  handlers.vendor_deal_requests = () => ({ data: [{
    id: REQ, vendor_id: VENDOR.id, requested_by: STAFF, title: 'Wings', body: 'Half price', duration_hours: 72, admin_note: 'Too vague',
  }] });
  handlers.vendors = () => ({ data: [{ name: VENDOR.name }] });
  handlers['rpc/vendor_staff_emails'] = () => ({ data: [{ vendor_id: VENDOR.id, user_id: STAFF, email: 'staff@tastyk.test', role: 'staff' }] });
  handlers.campaign_recipients = () => ({ data: [] });
  handlers.notification_log = () => ({ data: [] });
  handlers.email_suppressions = () => ({ data: [] });
}

describe('reviewDealRequest', () => {
  test('approve is refused before the disclosing policy is live, and nothing is called', async () => {
    reviewWorld({ status: 'approved' });
    const out = await reviewDealRequest({ id: REQ, reviewerId: ADMIN, approve: true, termsVersion: '2026-10-12' });
    assert.equal(out.status, 409);
    assert.equal(out.body.error, 'POLICY_NOT_LIVE');
    assert.equal(callsTo('rpc/review_deal_request').length, 0);
  });

  test('deny is allowed whatever the policy version', async () => {
    reviewWorld({ status: 'denied' });
    const out = await reviewDealRequest({ id: REQ, reviewerId: ADMIN, approve: false, note: 'Too vague', termsVersion: '2026-10-12' });
    assert.equal(out.status, 200);
    assert.equal(out.body.status, 'denied');
    const [rpc] = callsTo('rpc/review_deal_request');
    assert.equal(rpc.body.p_approve, false);
    assert.equal(rpc.body.p_note, 'Too vague');
    assert.equal(rpc.body.p_reviewer, ADMIN);
  });

  test('a decision that changed the request looks up the vendor to email them', async () => {
    reviewWorld({ status: 'denied' });
    const out = await reviewDealRequest({ id: REQ, reviewerId: ADMIN, approve: false, note: null });
    assert.equal(callsTo('rpc/vendor_staff_emails').length, 1);
    // Mail is off in the test environment (test/setup.js deletes RESEND_API_KEY),
    // so the operator is told it did NOT go, which is the honest answer here.
    assert.equal(out.body.emailed, false);
  });

  test('an already-decided request is a 409 and emails nobody', async () => {
    reviewWorld({ status: 'approved', changed: false });
    const out = await reviewDealRequest({ id: REQ, reviewerId: ADMIN, approve: true });
    assert.equal(out.status, 409);
    assert.equal(out.body.error, 'ALREADY_DECIDED');
    assert.equal(out.body.status, 'approved');
    assert.equal(callsTo('rpc/vendor_staff_emails').length, 0, 'a second click must not mail the vendor again');
  });

  test('approval reports how many students were queued', async () => {
    reviewWorld({ status: 'approved' });
    const out = await reviewDealRequest({ id: REQ, reviewerId: ADMIN, approve: true });
    assert.equal(out.status, 200);
    assert.equal(out.body.queued, 87);
    assert.equal(out.body.campaignId, CAMPAIGN);
    assert.equal(callsTo('rpc/review_deal_request')[0].body.p_approve, true);
    await tick();
  });

  test('a bad note or a missing decision never reaches the database', async () => {
    assert.equal((await reviewDealRequest({ id: REQ, approve: 'yes' })).status, 400);
    assert.equal((await reviewDealRequest({ id: REQ, approve: false, note: 'x'.repeat(501) })).status, 400);
    assert.equal(calls.length, 0);
  });

  test('without migration-069 it answers "not switched on"', async () => {
    const out = await reviewDealRequest({ id: REQ, reviewerId: ADMIN, approve: false });
    assert.equal(out.status, 503);
  });

  test('the operator queue degrades to available:false without the table', async () => {
    handlers.profiles = () => ({ data: [], total: 0 });
    const out = await listAdminDealRequests();
    assert.equal(out.status, 200);
    assert.equal(out.body.available, false);
  });
});

describe('takeDownEveryoneDeal', () => {
  test('cancels the approved deal’s campaign and expires it now', async () => {
    let patched = null;
    handlers.vendor_deal_requests = () => ({ data: [{ id: REQ, status: 'approved', campaign_id: CAMPAIGN }] });
    handlers.vendor_campaigns = (c) => { patched = c; return { data: [] }; };
    handlers.campaign_recipients = () => ({ data: [] });
    const out = await takeDownEveryoneDeal(REQ);
    assert.equal(out.status, 200);
    assert.equal(patched.method, 'PATCH');
    assert.equal(patched.params.get('id'), `eq.${CAMPAIGN}`);
    assert.equal(patched.body.status, 'cancelled');
    assert.ok(Date.parse(patched.body.expires_at) <= Date.now());
    await tick();
  });

  test('a request that was never approved has nothing to take down', async () => {
    handlers.vendor_deal_requests = () => ({ data: [{ id: REQ, status: 'denied', campaign_id: null }] });
    const out = await takeDownEveryoneDeal(REQ);
    assert.equal(out.status, 409);
  });
});
