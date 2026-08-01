// Measuring Dicks: Stripe donations.
//
// Talks to Stripe's REST API directly rather than pulling in the SDK. Node 22
// has global fetch, the two calls we need are form-encoded POSTs, and webhook
// verification is an HMAC that node:crypto already does. Adding a dependency
// would mean a Docker rebuild for no capability we do not already have.

import { createHash, createHmac, timingSafeEqual } from 'crypto';

const API = 'https://api.stripe.com/v1';

/** Nothing is sellable, so the minimum exists only to keep fees sane. */
export const MIN_INCHES = 3;
export const MAX_INCHES = 100000;

export interface CheckoutInput {
  inches: number;
  name?: string;
  ref?: string;
  origin: string;
  /** Stable per-person id so repeat donations stack onto one entry. */
  donor?: string;
  /** Placement that produced the click: banner, endgame, home. */
  from?: string;
  /** Page framing arm the donor was shown. */
  copy?: string;
}

/**
 * Where Stripe is allowed to send someone back to.
 *
 * The caller supplies its own origin so staging returns to staging and prod to
 * prod, but it is checked against this list first: success_url is attacker
 * controllable otherwise, which is a textbook open redirect.
 */
const ALLOWED_ORIGINS = [
  'https://cardsagainstformality.io',
  'https://www.cardsagainstformality.io',
  'https://measuringdicks.com',
  'https://www.measuringdicks.com',
  'https://caf-v2-staging.netlify.app',
  'http://localhost:5173',
  'http://localhost:5175',
];

export function safeOrigin(requested?: string): string {
  return requested && ALLOWED_ORIGINS.indexOf(requested) !== -1
    ? requested
    : 'https://cardsagainstformality.io';
}

const form = (obj: Record<string, string | number | undefined>) =>
  Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

/**
 * Creates a Checkout Session and returns its URL.
 *
 * The amount is carried as unit_amount with quantity 1, NOT as quantity=inches
 * with a $1 unit. Quantity must be a whole number, and the whole anchoring idea
 * depends on $5.25 being payable.
 */
export async function createCheckout(
  secretKey: string,
  { inches, name, ref, origin, donor, from, copy }: CheckoutInput,
): Promise<{ url: string; id: string }> {
  const cents = Math.round(inches * 100);
  if (!Number.isFinite(cents) || cents < MIN_INCHES * 100) {
    throw new Error(`Minimum is $${MIN_INCHES}`);
  }
  if (cents > MAX_INCHES * 100) throw new Error('Amount too large');

  let body = form({
    mode: 'payment',
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': cents,
    'line_items[0][price_data][product_data][name]': `${inches} inches`,
    'line_items[0][price_data][product_data][description]':
      'A number on a public leaderboard. No prize, no packs, not tax deductible.',
    // Stripe Managed Payments (on by default on this account) requires a tax
    // code, and rejects the "Nontaxable" one as ineligible. This is the closest
    // eligible fit: the thing delivered is a leaderboard entry, i.e. an
    // electronically supplied service. Stripe is merchant of record and may add
    // sales tax on top for some regions; the leaderboard reads metadata.inches,
    // not amount_total, so tax never inflates anyone's number.
    'line_items[0][price_data][product_data][tax_code]': 'txcd_10000000',
    // Echoed back on the webhook. This is the only place the display name and
    // referral survive the round trip through Stripe.
    'metadata[inches]': String(inches),
    'metadata[name]': (name || '').slice(0, 40),
    'metadata[ref]': (ref || '').slice(0, 40),
    'metadata[donor]': (donor || '').slice(0, 64),
    // Which placement sent them. The whole point of shipping three at once
    // is finding out which one earns, and that is unknowable after the fact.
    'metadata[from]': (from || '').slice(0, 24),
    // Which page framing was on screen. Same reason as `from`.
    'metadata[copy]': (copy || '').slice(0, 16),
    success_url: `${safeOrigin(origin)}/measure/?paid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${safeOrigin(origin)}/measure/`,
    submit_type: 'donate',
  });

  // A real, logged marketing opt-in rendered by Stripe on the payment page.
  // Without it the only email we ever see is the one Stripe collects for its
  // receipt, and a receipt address is not consent to a newsletter.
  //
  // Gated: Stripe rejects this parameter outright ("please visit the dashboard
  // to agree to the Terms of Service") until that ToS is accepted, and a
  // rejected parameter fails the whole checkout call. So it stays off until
  // STRIPE_CONSENT is set, which is the same moment the ToS gets accepted.
  if (process.env.STRIPE_CONSENT === '1') {
    body += '&consent_collection%5Bpromotions%5D=auto';
  }

  // Same escape hatch the Beehiiv call uses: Node 22 has fetch, the TS 3.2
  // lib does not know about it.
  const fetchFn = (globalThis as any).fetch;
  const res = await fetchFn(`${API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Same inches from the same person within a second should not open two
      // sessions; Stripe dedupes on this for 24h.
      'Idempotency-Key': `md_${cents}_${(name || 'anon').slice(0, 20)}_${Math.floor(Date.now() / 1000)}`,
    },
    body,
  });

  const json: any = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || `Stripe ${res.status}`);
  return { url: json.url, id: json.id };
}

/**
 * Verifies a Stripe webhook signature against the RAW request body.
 *
 * Must be the exact bytes Stripe sent. Any re-serialisation (a JSON parse and
 * re-stringify, a whitespace change) produces a different HMAC and every event
 * is rejected, which is the classic way this silently breaks.
 */
export function verifySignature(raw: string, header: string, secret: string): boolean {
  if (!raw || !header || !secret) return false;

  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=').map((s) => s.trim()) as [string, string]),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;

  // Reject anything older than five minutes so a captured request cannot be
  // replayed later.
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected = createHmac('sha256', secret).update(`${t}.${raw}`, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface DonationRow {
  _id: string;
  sessionId: string;
  inches: number;
  amountCents: number;
  name: string;
  ref: string;
  /** Groups repeat donations from the same person into one leaderboard entry. */
  donor: string;
  /** Which on-site placement produced the click. */
  from?: string;
  /** Which page framing was on screen: the messaging A/B arm. */
  copy?: string;
  ts: number;
  livemode: boolean;
  /** Whether the donor ticked Stripe's marketing opt-in. Proof, not an address. */
  promo?: boolean;
}

/**
 * Writes a confirmed donation, exactly once.
 *
 * Stripe retries a webhook until it gets a 2xx, and will happily deliver the
 * same event more than once even after success. The event id is the primary
 * key, so a replay collides and is ignored rather than crediting twice.
 */
export interface DonationResult {
  result: 'inserted' | 'duplicate';
  /** Only set when the donor actually ticked the box on Stripe's page. */
  optInEmail?: string;
}

export async function recordDonation(db: any, event: any): Promise<DonationResult> {
  const session = event?.data?.object;
  if (!session) throw new Error('malformed event');

  // Stripe collects an email to send its receipt. That is NOT permission to
  // put someone on a mailing list, so the address only travels onward when
  // consent.promotions came back as an explicit opt_in.
  const optedIn = session?.consent?.promotions === 'opt_in';
  const email = String(session?.customer_details?.email || '').slice(0, 200);

  const inches = Number(session?.metadata?.inches ?? 0);
  const row: DonationRow = {
    _id: event.id,
    sessionId: session.id,
    inches,
    amountCents: Number(session.amount_total ?? Math.round(inches * 100)),
    name: (session?.metadata?.name || '').slice(0, 40) || 'Anonymous',
    ref: (session?.metadata?.ref || '').slice(0, 40),
    donor: (session?.metadata?.donor || '').slice(0, 64),
    from: (session?.metadata?.from || '').slice(0, 24),
    copy: (session?.metadata?.copy || '').slice(0, 16),
    ts: (Number(event.created) || Math.floor(Date.now() / 1000)) * 1000,
    livemode: !!event.livemode,
    // The flag is kept as proof of consent. The address deliberately is NOT:
    // it goes straight to the mailing list and is never stored here, so this
    // collection never becomes a pile of donor emails to look after.
    promo: optedIn,
  };

  try {
    await db.collection('donations').insertOne(row);
    return { result: 'inserted', optInEmail: optedIn && email ? email : undefined };
  } catch (e) {
    // 11000 is a duplicate key: the same event id already landed, i.e. a replay.
    // No opt-in is returned, so a replay cannot resubscribe anyone.
    if ((e as any)?.code === 11000) return { result: 'duplicate' };
    throw e;
  }
}

/**
 * Leaderboard, biggest first.
 *
 * Rows are grouped by donor so topping up GROWS your entry rather than adding a
 * second one: the whole mechanic is that more money means a longer one, which
 * only works if repeat payments accumulate. Anyone without a donor id (an old
 * row, or a blocked localStorage) falls back to standing alone, keyed on their
 * own session.
 */
export async function board(db: any, span: 'all' | 'month', limit = 100) {
  const match: any = {};
  if (span === 'month') {
    const d = new Date();
    match.ts = { $gte: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) };
  }

  const rows = await db.collection('donations').aggregate([
    { $match: match },
    {
      $group: {
        _id: { $ifNull: ['$donor', '$sessionId'] },
        inches: { $sum: '$inches' },
        // Newest name wins, so renaming applies to the whole stacked entry.
        name: { $last: '$name' },
        ts: { $min: '$ts' },
        gifts: { $sum: 1 },
        // Carried so the row can be scrubbed below when there is no donor.
        donor: { $first: '$donor' },
      },
    },
    { $sort: { inches: -1, ts: 1 } },
    { $limit: limit },
  ]).toArray();

  const totalAgg = await db.collection('donations')
    .aggregate([{ $group: { _id: null, n: { $sum: '$inches' } } }]).toArray();

  // Girth is earned per donor id, so it rides along with the grouped rows.
  const girth = await girthFor(db, rows.map((r: any) => String(r._id)));
  for (const r of rows) r.girth = girth[String(r._id)] ?? 0;

  // A donation made before donor ids existed, or in a browser with storage
  // blocked, groups under its Stripe SESSION id. That id is the only thing
  // claimName checks, so publishing it on a public board would let anyone
  // rename that entry. Donor ids are fine to expose (they are already the
  // public ?ref= token, and the client matches its own row against them);
  // session ids are replaced with a one-way digest that matches nothing.
  for (const r of rows) {
    if (!r.donor) r._id = `anon-${createHash('sha256').update(String(r._id)).digest('hex').slice(0, 16)}`;
    delete r.donor;
  }

  return { rows, totalInches: totalAgg[0]?.n ?? 0 };
}

/** Everything one donor has put in, for the "your entry grew" reveal. */
export async function donorTotal(db: any, donor: string) {
  if (!donor) return null;
  const agg = await db.collection('donations').aggregate([
    { $match: { donor } },
    { $group: { _id: '$donor', inches: { $sum: '$inches' }, name: { $last: '$name' }, gifts: { $sum: 1 } } },
  ]).toArray();
  if (!agg.length) return null;
  const bigger = await db.collection('donations').aggregate([
    { $group: { _id: { $ifNull: ['$donor', '$sessionId'] }, inches: { $sum: '$inches' } } },
    { $match: { inches: { $gt: agg[0].inches } } },
    { $count: 'n' },
  ]).toArray();
  const g = await girthFor(db, [donor]);
  return {
    inches: agg[0].inches, name: agg[0].name, gifts: agg[0].gifts,
    girth: g[donor] ?? 0, rank: (bigger[0]?.n ?? 0) + 1,
  };
}

/**
 * What the success page asks for after Stripe sends someone back.
 *
 * The redirect can beat the webhook, so a miss here is normal for a second or
 * two rather than an error. Falls back to asking Stripe directly, which lets
 * the reveal render immediately while the row is still in flight.
 *
 * Reports the donor's RUNNING TOTAL, not just this payment, so a top-up shows
 * the entry it grew into rather than the amount just added.
 */
export async function sessionStatus(db: any, secretKey: string, sessionId: string) {
  const row = await db.collection('donations').findOne({ sessionId });
  if (row) {
    const stacked = row.donor ? await donorTotal(db, row.donor) : null;
    if (stacked) {
      return { paid: true, recorded: true, ...stacked, added: row.inches };
    }
    const bigger = await db.collection('donations').countDocuments({ inches: { $gt: row.inches } });
    return { paid: true, recorded: true, inches: row.inches, name: row.name, rank: bigger + 1, gifts: 1, added: row.inches };
  }

  const fetchFn = (globalThis as any).fetch;
  const res = await fetchFn(`${API}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const s: any = await res.json();
  if (!res.ok || s.payment_status !== 'paid') return { paid: false, recorded: false };

  const inches = Number(s?.metadata?.inches ?? 0);
  const donor = (s?.metadata?.donor || '').slice(0, 64);
  const stacked = donor ? await donorTotal(db, donor) : null;
  const total = (stacked?.inches ?? 0) + inches;   // webhook not in yet
  const bigger = await db.collection('donations').aggregate([
    { $group: { _id: { $ifNull: ['$donor', '$sessionId'] }, inches: { $sum: '$inches' } } },
    { $match: { inches: { $gt: total } } },
    { $count: 'n' },
  ]).toArray();

  return {
    paid: true,
    recorded: false,
    inches: total,
    added: inches,
    gifts: (stacked?.gifts ?? 0) + 1,
    name: (s?.metadata?.name || stacked?.name || '').slice(0, 40) || 'Anonymous',
    rank: (bigger[0]?.n ?? 0) + 1,
  };
}

/**
 * Sets the display name on an existing donation.
 *
 * Authorised by the checkout session id alone. That is deliberate and enough:
 * the id is unguessable, Stripe only ever puts it in the success_url of the
 * person who paid, and the worst case is someone renaming their own row.
 * Applies to every payment from that donor, so a stacked entry stays one name.
 */
export async function claimName(db: any, sessionId: string, name: string) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('Name required');

  const row = await db.collection('donations').findOne({ sessionId });
  if (!row) throw new Error('No donation for that session');

  if (row.donor) {
    await db.collection('donations').updateMany({ donor: row.donor }, { $set: { name: clean } });
  } else {
    await db.collection('donations').updateOne({ sessionId }, { $set: { name: clean } });
  }
  return { name: clean, inches: row.inches };
}


/**
 * Girth. One millimetre per unique person who follows your link.
 *
 * Deduped on (ref, visitor) via a unique _id, so refreshing, or one obsessive
 * friend, cannot inflate it. The same trick as the webhook: let the primary key
 * do the work rather than checking-then-writing, which races.
 */
export async function recordClick(db: any, ref: string, visitor: string) {
  const r = String(ref || '').slice(0, 64);
  const v = String(visitor || '').slice(0, 64);
  if (!r || !v || r === v) return 'ignored';        // never credit your own click
  try {
    await db.collection('donation_clicks').insertOne({ _id: `${r}:${v}`, ref: r, ts: Date.now() });
    return 'counted';
  } catch (e) {
    if ((e as any)?.code === 11000) return 'duplicate';
    throw e;
  }
}

/** Girth per donor, in millimetres, for however many donors are asked about. */
export async function girthFor(db: any, refs: string[]): Promise<Record<string, number>> {
  if (!refs.length) return {};
  const rows = await db.collection('donation_clicks').aggregate([
    { $match: { ref: { $in: refs } } },
    { $group: { _id: '$ref', n: { $sum: 1 } } },
  ]).toArray();
  const out: Record<string, number> = {};
  for (const r of rows) out[r._id] = r.n;
  return out;
}

/**
 * Display names, filtered.
 *
 * Not a moderation policy and not a promise to anyone: it exists because
 * Stripe's prohibited-use terms cover what a connected site displays, and
 * losing the processor would end the project overnight. Slurs only — crude,
 * obscene and tasteless all sail straight through, which on this site is the
 * entire point.
 */
const BLOCKED = [
  'nigg', 'n1gg', 'faggot', 'f4ggot', 'tranny', 'kike', 'spic', 'chink',
  'wetback', 'towelhead', 'gook', 'coon', 'raghead', 'beaner', 'retard',
];

export function nameIsBlocked(name: string): boolean {
  // Strip separators first: l e e t and punctuation are how these get past a
  // naive substring check.
  const flat = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a')
    .replace(/5/g, 's').replace(/7/g, 't').replace(/@/g, 'a').replace(/\$/g, 's');
  return BLOCKED.some((w) => flat.includes(w));
}
