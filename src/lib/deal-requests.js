// All-student deal requests (migration-069).
//
// A vendor's own deals reach only that vendor's customers, and that is a policy:
// campaign_audience caps a vendor at 100 of them because no vendor should be
// able to address the student body. This file is the one way past that cap,
// and it is a QUESTION rather than a send. The vendor asks from the terminal;
// the operator approves or denies the ask from /admin; the vendor is emailed the
// answer, with the operator's note when there is one. Only an approval writes
// anything a student sees, and what it writes is an ordinary campaign, so the
// shared frequency budget, quiet hours, every switch and the push-then-email
// fallback apply to it exactly as they apply to any deal (see migration-069).
//
// Each exported action returns { status, body } rather than touching `res`, so
// the routes in src/routes/vendor.js and src/routes/admin.js stay one line each
// and test/deal-requests.test.js can drive the whole flow against a fake
// PostgREST without an HTTP server.
//
// TOLERATES THE MIGRATION BEING ABSENT. A missing table or function answers
// "not switched on yet" (503 on a write, available:false on a read) rather than
// a 500, so this can ship before migration-069 is pasted.

import { supabaseAdmin } from './supabase.js';
import { CAMPAIGN_CONFIG, CAMPAIGN_DURATIONS } from './campaigns.js';
import { emitDeal } from './realtime.js';
import { notifyAdmins } from './push.js';
import { sendEmail, emailUrl } from './email.js';
import { dealRequestDecision } from './email-templates.js';
import { TERMS_VERSION, EVERYONE_DEALS_TERMS_VERSION } from './terms.js';

export const DEAL_REQUEST_TITLE_MAX = 60;    // = the CHECK on vendor_deal_requests.title
export const DEAL_REQUEST_BODY_MAX = 140;    // = the CHECK on vendor_deal_requests.body
export const DEAL_REQUEST_NOTE_MAX = 500;    // = the CHECK on vendor_deal_requests.admin_note
const VENDOR_LIST_LIMIT = 10;
const ADMIN_DECIDED_LIMIT = 20;

// A missing relation (42P01 / PGRST205), column (42703 / PGRST204) or function
// (42883 / PGRST202): migration-069 has not been applied to this database.
const MISSING_CODES = new Set(['42P01', 'PGRST205', '42703', 'PGRST204', '42883', 'PGRST202']);
export const isDealRequestsSchemaMissing = (error) => MISSING_CODES.has(String(error?.code ?? ''));

const UNAVAILABLE = {
  status: 503,
  body: {
    error: 'DEAL_REQUESTS_UNAVAILABLE',
    message: 'Sending a deal to every student isn’t switched on yet. Try again soon.',
  },
};

const bad = (message) => ({ status: 400, body: { error: 'BAD_DEAL_REQUEST', message } });

/**
 * Is the Privacy Policy that discloses all-student deals the one students are
 * being asked to accept? Approval refuses until it is: see the
 * EVERYONE_DEALS_TERMS_VERSION note in src/lib/terms.js. Versions are ISO
 * dates, so string order is date order.
 */
export function everyoneDealsDisclosed(version = TERMS_VERSION) {
  return String(version ?? '') >= EVERYONE_DEALS_TERMS_VERSION;
}

/**
 * Validate what the terminal sent. Non-strings fold to '' and take the same
 * refusal as an empty field, rather than a TypeError from .trim().
 *
 * @returns {{ value: { title: string, body: string, durationHours: number } } | { error: string }}
 */
export function validDealRequest(raw) {
  const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
  const body = typeof raw?.body === 'string' ? raw.body.trim() : '';
  const durationHours = Number(raw?.durationHours ?? CAMPAIGN_CONFIG.defaultDurationHours);
  if (!title || title.length > DEAL_REQUEST_TITLE_MAX) {
    return { error: `Give the deal a headline (up to ${DEAL_REQUEST_TITLE_MAX} characters).` };
  }
  if (!body || body.length > DEAL_REQUEST_BODY_MAX) {
    return { error: `Write the message (up to ${DEAL_REQUEST_BODY_MAX} characters).` };
  }
  if (!CAMPAIGN_DURATIONS.includes(durationHours)) {
    return { error: 'Pick how long the deal runs.' };
  }
  return { value: { title, body, durationHours } };
}

/** The operator's optional note. Blank means no note, never an empty string. */
export function validNote(raw) {
  if (raw == null) return { note: null };
  if (typeof raw !== 'string') return { error: 'The note has to be text.' };
  const note = raw.trim();
  if (note.length > DEAL_REQUEST_NOTE_MAX) {
    return { error: `Keep the note under ${DEAL_REQUEST_NOTE_MAX} characters.` };
  }
  if (note.includes('—')) {
    // The repo copy rule, and the vendor reads this verbatim in an email.
    return { error: 'Use a comma or a full stop instead of an em dash (house copy rule).' };
  }
  return { note: note || null };
}

/** What the terminal is shown about one request. No reviewer identity. */
export function vendorView(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    durationHours: row.duration_hours,
    status: row.status,
    note: row.admin_note ?? null,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at ?? null,
  };
}

/* ---------- the vendor's side ---------- */

/** The terminal's list: this vendor's recent requests, newest first. */
export async function listVendorDealRequests(vendorId) {
  const { data, error } = await supabaseAdmin
    .from('vendor_deal_requests')
    .select('id, title, body, duration_hours, status, admin_note, created_at, reviewed_at')
    .eq('vendor_id', vendorId)
    .order('created_at', { ascending: false })
    .limit(VENDOR_LIST_LIMIT);
  if (error) {
    if (isDealRequestsSchemaMissing(error)) return { status: 200, body: { available: false, requests: [], pending: false } };
    throw error;
  }
  const requests = (data ?? []).map(vendorView);
  return { status: 200, body: { available: true, requests, pending: requests.some((r) => r.status === 'pending') } };
}

/**
 * Queue a request. Writes nothing a student can see; tells every operator
 * device that one is waiting.
 */
export async function submitDealRequest({ vendor, userId, input, requestId }) {
  const v = validDealRequest(input);
  if (v.error) return bad(v.error);

  const clientToken = (typeof requestId === 'string' && /^[\w-]{8,64}$/.test(requestId)) ? requestId : null;

  const { data, error } = await supabaseAdmin.rpc('submit_deal_request', {
    p_vendor_id: vendor.id,
    p_requested_by: userId ?? null,
    p_title: v.value.title,
    p_body: v.value.body,
    p_kind: 'deal',
    p_duration_hours: v.value.durationHours,
    p_client_token: clientToken,
  });
  if (error) {
    if (isDealRequestsSchemaMissing(error)) return UNAVAILABLE;
    const m = String(error.message ?? '');
    if (m.includes('DEAL_REQUEST_PENDING')) {
      return {
        status: 409,
        body: {
          error: 'REQUEST_PENDING',
          message: 'You already have a request waiting for review. Withdraw it below or wait for our answer.',
        },
      };
    }
    if (m.includes('VENDOR_UNAVAILABLE')) {
      return { status: 409, body: { error: 'VENDOR_UNAVAILABLE', message: 'This spot is switched off, so it can’t send deals right now.' } };
    }
    if (/CAMPAIGN_(TITLE|BODY|KIND|DURATION)_INVALID/.test(m)) return bad('Check the headline, message and length, then try again.');
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  // A replayed token that finds a request which has since been withdrawn or
  // answered must not read as "sent for review": the vendor's new wording was
  // never stored. Refused, so the terminal drops the token and the next tap is
  // a new request.
  if (row?.out_reused && row.out_status !== 'pending') {
    return {
      status: 409,
      body: {
        error: 'REQUEST_ALREADY_CLOSED',
        message: `Your last request was already ${row.out_status}. Tap the button again to send this one as a new request.`,
      },
    };
  }
  if (!row?.out_reused) {
    // Fire-and-forget: a request that is safely stored must not fail because
    // an operator's browser could not be reached. notifyAdmins never throws.
    void notifyAdmins({
      title: `Deal request: ${vendor.name ?? 'a spot'}`,
      body: `${v.value.title}. Open Broadcast to approve or deny it.`,
      url: '/admin/',
      tag: 'wr-deal-request',
    }, { kind: 'admin_alert', ref: { dealRequestId: row?.out_id ?? null } });
  }

  return {
    status: row?.out_reused ? 200 : 201,
    body: {
      request: { id: row?.out_id ?? null, status: row?.out_status ?? 'pending' },
      reused: Boolean(row?.out_reused),
      message: 'Request sent to WeRewards for review. We’ll email you when it’s approved or denied.',
    },
  };
}

/** Withdraw this vendor's own pending request. Idempotent on an already-withdrawn one. */
export async function withdrawDealRequest(vendorId, id) {
  const { data, error } = await supabaseAdmin
    .from('vendor_deal_requests')
    .update({ status: 'withdrawn' })
    .eq('id', id)
    .eq('vendor_id', vendorId)
    .in('status', ['pending', 'withdrawn'])
    .select('id, status')
    .maybeSingle();
  if (error) {
    if (isDealRequestsSchemaMissing(error)) return UNAVAILABLE;
    throw error;
  }
  if (!data) {
    return { status: 409, body: { error: 'NOT_PENDING', message: 'That request has already been answered.' } };
  }
  return { status: 200, body: { ok: true } };
}

/* ---------- the operator's side ---------- */

/**
 * The /admin queue: every pending request (oldest first, the order to answer
 * them in) and the most recent decisions, with spot names, the requesting
 * login's address, and how an approved deal is getting on.
 */
export async function listAdminDealRequests() {
  const cols = 'id, vendor_id, requested_by, title, body, duration_hours, status, admin_note, reviewed_by, reviewed_at, campaign_id, queued_count, created_at';
  const [pending, decided, students] = await Promise.all([
    supabaseAdmin.from('vendor_deal_requests').select(cols)
      .eq('status', 'pending').order('created_at', { ascending: true }),
    supabaseAdmin.from('vendor_deal_requests').select(cols)
      .neq('status', 'pending').order('created_at', { ascending: false }).limit(ADMIN_DECIDED_LIMIT),
    supabaseAdmin.from('profiles').select('user_id', { count: 'exact', head: true }),
  ]);
  for (const r of [pending, decided]) {
    if (r.error) {
      if (isDealRequestsSchemaMissing(r.error)) {
        return { status: 200, body: { available: false, pending: [], decided: [], students: null, disclosed: everyoneDealsDisclosed() } };
      }
      throw r.error;
    }
  }

  const rows = [...(pending.data ?? []), ...(decided.data ?? [])];
  const vendorIds = [...new Set(rows.map((r) => r.vendor_id).filter(Boolean))];
  const campaignIds = [...new Set(rows.map((r) => r.campaign_id).filter(Boolean))];

  const [vendors, logins, campaigns] = await Promise.all([
    vendorIds.length
      ? supabaseAdmin.from('vendors').select('id, name, active').in('id', vendorIds)
      : { data: [] },
    vendorIds.length
      ? supabaseAdmin.rpc('vendor_staff_emails', { p_vendor_ids: vendorIds })
      : { data: [] },
    campaignIds.length
      ? supabaseAdmin.from('vendor_campaigns').select('id, status, expires_at, queued_count, sent_count').in('id', campaignIds)
      : { data: [] },
  ]);
  const vendorById = new Map((vendors.data ?? []).map((v) => [v.id, v]));
  const emailByUser = new Map((logins.data ?? []).map((s) => [s.user_id, s.email]));
  const campaignById = new Map((campaigns.data ?? []).map((c) => [c.id, c]));
  const now = Date.now();

  const shape = (r) => {
    const c = r.campaign_id ? campaignById.get(r.campaign_id) : null;
    return {
      id: r.id,
      vendorId: r.vendor_id,
      vendorName: vendorById.get(r.vendor_id)?.name ?? 'Unknown spot',
      vendorActive: vendorById.get(r.vendor_id)?.active !== false,
      requestedBy: r.requested_by ? (emailByUser.get(r.requested_by) ?? null) : null,
      title: r.title,
      body: r.body,
      durationHours: r.duration_hours,
      status: r.status,
      note: r.admin_note ?? null,
      reviewedAt: r.reviewed_at ?? null,
      createdAt: r.created_at,
      queued: r.queued_count ?? null,
      deal: c ? {
        live: c.status !== 'cancelled' && new Date(c.expires_at).getTime() > now,
        cancelled: c.status === 'cancelled',
        expiresAt: c.expires_at,
        sent: c.sent_count ?? 0,
      } : null,
    };
  };

  return {
    status: 200,
    body: {
      available: true,
      pending: (pending.data ?? []).map(shape),
      decided: (decided.data ?? []).map(shape),
      students: Number.isFinite(students?.count) ? students.count : null,
      disclosed: everyoneDealsDisclosed(),
    },
  };
}

/**
 * Which login hears the answer: the one that asked, if it is still staff of the
 * spot; otherwise an owner; otherwise anyone on the roster. One address, not the
 * whole roster: this answers a question one person asked.
 */
export function pickRecipient(logins, requestedBy) {
  const list = (logins ?? []).filter((s) => s?.email);
  return list.find((s) => s.user_id === requestedBy)
    ?? list.find((s) => s.role === 'owner')
    ?? list[0]
    ?? null;
}

/** Email the vendor the decision. Resolves to { ok, to }; never throws. */
export async function mailDealDecision({ request, vendorName, approved, req = null }) {
  try {
    const { data: logins, error } = await supabaseAdmin
      .rpc('vendor_staff_emails', { p_vendor_ids: [request.vendor_id] });
    if (error) throw error;
    const to = pickRecipient(logins, request.requested_by);
    if (!to) return { ok: false, to: null, reason: 'no_login' };

    const mail = dealRequestDecision({
      businessName: vendorName,
      approved,
      title: request.title,
      body: request.body,
      note: request.admin_note ?? '',
      durationHours: request.duration_hours,
      terminalUrl: emailUrl('/terminal/', req),
      quietStart: CAMPAIGN_CONFIG.quietStart,
      quietEnd: CAMPAIGN_CONFIG.quietEnd,
    });
    const res = await sendEmail({
      to: to.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      category: 'transactional',
      // One decision per request, ever, so the decision itself is the key: a
      // retried approve that somehow reached here twice mails once.
      idempotencyKey: `deal-request:${request.id}:${approved ? 'approved' : 'denied'}`,
      tags: ['deal_request'],
      log: {
        kind: 'deal_request',
        recipientKind: 'vendor',
        vendorId: request.vendor_id,
        recipientUserId: to.user_id ?? null,
        recipientLabel: vendorName ?? null,
        ref: { dealRequestId: request.id, decision: approved ? 'approved' : 'denied' },
      },
    });
    return { ok: Boolean(res?.ok), to: to.email, reason: res?.ok ? null : (res?.reason ?? null) };
  } catch (err) {
    console.warn(`[deal-requests] decision email failed request=${request?.id}: ${err?.message ?? err}`);
    return { ok: false, to: null, reason: 'error' };
  }
}

/**
 * Approve or deny. The decision is final and made under a row lock in
 * review_deal_request, so a double click or an Approve racing a Deny cannot
 * queue twice or email twice: only the call that actually changed the request
 * (out_changed) sends the email.
 */
//
// `termsVersion` exists for test/deal-requests.test.js, which has to prove the
// policy gate refuses without editing src/lib/terms.js. Routes never pass it.
export async function reviewDealRequest({ id, reviewerId, approve, note, req = null, termsVersion = TERMS_VERSION }) {
  if (typeof approve !== 'boolean') return bad('Choose approve or deny.');
  const n = validNote(note);
  if (n.error) return bad(n.error);
  if (approve && !everyoneDealsDisclosed(termsVersion)) {
    return {
      status: 409,
      body: {
        error: 'POLICY_NOT_LIVE',
        message: `Approving needs the Privacy Policy update that discloses all-student deals (TERMS_VERSION ${EVERYONE_DEALS_TERMS_VERSION} or later). You can still deny.`,
      },
    };
  }

  const { data, error } = await supabaseAdmin.rpc('review_deal_request', {
    p_request_id: id,
    p_reviewer: reviewerId ?? null,
    p_approve: approve,
    p_note: n.note,
    p_coalesce_minutes: CAMPAIGN_CONFIG.coalesceMinutes,
  });
  if (error) {
    if (isDealRequestsSchemaMissing(error)) return UNAVAILABLE;
    const m = String(error.message ?? '');
    if (m.includes('DEAL_REQUEST_NOT_FOUND')) return { status: 404, body: { error: 'NOT_FOUND', message: 'That request no longer exists.' } };
    if (m.includes('VENDOR_UNAVAILABLE')) {
      return { status: 409, body: { error: 'VENDOR_UNAVAILABLE', message: 'That spot is switched off, so the deal can’t go out. Deny it with a note instead.' } };
    }
    if (m.includes('NOTE_TOO_LONG')) return bad(`Keep the note under ${DEAL_REQUEST_NOTE_MAX} characters.`);
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.out_changed) {
    return {
      status: 409,
      body: { error: 'ALREADY_DECIDED', status: row?.out_status ?? null, message: `That request was already ${row?.out_status ?? 'answered'}.` },
    };
  }
  const approved = row.out_status === 'approved';

  // Students with the app open see the deal in their list without a poll, the
  // same nudge POST /api/vendor/campaigns gives. Fire-and-forget.
  if (approved && row.out_campaign_id) {
    supabaseAdmin
      .from('campaign_recipients')
      .select('user_id')
      .eq('campaign_id', row.out_campaign_id)
      .then(({ data: rows }) => {
        for (const r of rows ?? []) emitDeal(r.user_id, { campaignId: row.out_campaign_id });
      }, () => {});
  }

  // Awaited, unlike the nudge: the operator is told whether the vendor was
  // actually emailed, so a failed mail can be followed up by phone.
  const { data: request } = await supabaseAdmin
    .from('vendor_deal_requests')
    .select('id, vendor_id, requested_by, title, body, duration_hours, admin_note')
    .eq('id', id)
    .maybeSingle();
  const { data: vendor } = await supabaseAdmin
    .from('vendors').select('name').eq('id', row.out_vendor_id).maybeSingle();
  const mail = request
    ? await mailDealDecision({ request, vendorName: vendor?.name ?? null, approved, req })
    : { ok: false, to: null, reason: 'reload_failed' };

  return {
    status: 200,
    body: {
      status: row.out_status,
      campaignId: row.out_campaign_id ?? null,
      queued: approved ? Number(row.out_queued ?? 0) : null,
      emailed: mail.ok,
      emailTo: mail.to,
    },
  };
}

/**
 * Take an approved deal down from /admin. The same two writes DELETE
 * /api/vendor/campaigns/:id makes: expires_at = now() is what stops delivery
 * and removes it from every Deals list; the recipient flip is bookkeeping.
 * Rows a worker is mid-send on ('sending') are left for it to settle.
 */
export async function takeDownEveryoneDeal(id) {
  const { data: request, error } = await supabaseAdmin
    .from('vendor_deal_requests')
    .select('id, status, campaign_id')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    if (isDealRequestsSchemaMissing(error)) return UNAVAILABLE;
    throw error;
  }
  if (!request) return { status: 404, body: { error: 'NOT_FOUND', message: 'That request no longer exists.' } };
  if (request.status !== 'approved' || !request.campaign_id) {
    return { status: 409, body: { error: 'NOT_LIVE', message: 'Only an approved deal can be taken down.' } };
  }

  const { error: upErr } = await supabaseAdmin
    .from('vendor_campaigns')
    .update({ status: 'cancelled', expires_at: new Date().toISOString() })
    .eq('id', request.campaign_id)
    .neq('status', 'cancelled');
  if (upErr) throw upErr;

  await supabaseAdmin
    .from('campaign_recipients')
    .update({ status: 'expired' })
    .eq('campaign_id', request.campaign_id)
    .eq('status', 'queued');

  supabaseAdmin
    .from('campaign_recipients')
    .select('user_id')
    .eq('campaign_id', request.campaign_id)
    .then(({ data: rows }) => {
      for (const r of rows ?? []) emitDeal(r.user_id, { campaignId: request.campaign_id });
    }, () => {});

  return { status: 200, body: { ok: true } };
}
