#!/usr/bin/env node
/**
 * Full production pull for the Playable / Cards Against Formality corpus.
 *
 * Mirrors the 2026-07-27 extract so the two are directly comparable, and adds
 * what has been built since: donations, donation clicks, and the placement
 * tagged promo events behind the fundraiser.
 *
 *   MONGO_URI=... node extract.js /path/to/out
 *
 * Read-only. Writes JSON per collection plus a summary.
 */
const fs = require('fs');
const path = require('path');
const { MongoClient } = require(
  path.join(process.env.HOME, 'cards-against-formality-services/services/clients-service/node_modules/mongodb'),
);

// The capture path never denormalises tags into rows. It stores card ids plus
// context.tagset and expects the join to happen here. It never did, so every
// pull of this corpus looked untagged: 6.8M labelled card observations sitting
// one join away, invisible to anyone reading the export.
const TAGDIR = path.join(process.env.HOME, 'cards-against-formality-services/services/games-service/src/data');
const readTags = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(TAGDIR, f), 'utf8')); }
  catch (e) { console.warn(`  WARN: no ${f}, rows will be under-tagged`); return {}; }
};
const TAG_V2 = readTags('card-tags-v2.json');   // heat + flavours (partner-scored)
const TAG_V1 = readTags('card-tags-v1.json');   // edge/mode/register/sincerity
const TAG_PR = readTags('prompt-tags-v1.json'); // topics + grade, prompts only
// The 252 authored measurement candidates. They carry RICHER tags than the base
// deck (a class and a measures axis, not just heat) but live in the `cards` db
// under fresh ObjectIds, so neither v1 nor v2 covers them. Resolved by text.
const TAG_SIG = readTags('signal-tags-resolved.json');

/** h heat, m mode (grounded<0 absurd>0), r register, s sincerity, f flavours. */
function tagOf(id) {
  const g = TAG_SIG[id];
  if (g) {
    return {
      heat: g.h, cls: g.cls, source: g.src, amp: g.amp,
      measuresPrimary: g.measures && g.measures.primary,
      measuresSecondary: g.measures && g.measures.secondary,
      pole: g.measures && g.measures.pole_or_flavor,
    };
  }
  const a = TAG_V2[id], b = TAG_V1[id];
  if (!a && !b) return null;
  const t = {};
  if (a) {
    if (a.h != null) t.heat = a.h;
    if (a.m != null) t.mode = a.m;
    if (a.r != null) t.register = a.r;
    if (a.s != null) t.sincerity = a.s;
    if (a.f) t.flavors = a.f;
    if (a.cls) t.cls = a.cls;
  }
  if (b && b.e != null && t.edge == null) t.edge = b.e;
  return Object.keys(t).length ? t : null;
}

const OUT = process.argv[2];
if (!OUT || !process.env.MONGO_URI) {
  console.error('usage: MONGO_URI=... node extract.js <outdir>');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

// db -> [collection, filename, optional projection to drop bulk/PII]
const PULLS = [
  ['games', 'round_analytics',    'rounds.json',            null],
  ['games', 'signal_impressions', 'impressions.json',       null],
  ['games', 'humor_leaderboard',  'leaderboard.json',       null],
  ['games', 'wyr_responses',      'wyr-all.json',           null],
  ['games', 'tot_responses',      'tot-all.json',           null],
  ['games', 'ml_tally',           'ml-tally.json',          null],
  ['games', 'ml_events',          'ml-events.json',         null],
  ['games', 'discard_events',     'discards.json',          null],
  ['games', 'bug_reports',        'bug-reports.json',       null],
  ['games', 'promo_events',       'promo-events.json',      null],
  ['games', 'cards',              'cards.json',             null],
  ['games', 'decks',              'decks.json',             null],
  ['clients', 'donations',        'donations.json',         null],
  ['clients', 'donation_clicks',  'donation-clicks.json',   null],
  // Player records carry emails. Counts and consent flags are the useful part
  // for analysis; the addresses are not, and an export on a laptop is the
  // wrong place for 24k of them.
  ['clients', 'clients',          'players.json',
    { _id: 1, username: 1, marketingOptIn: 1, marketingOptInAt: 1, roomId: 1, disconnectedAt: 1 }],
  ['rooms', 'rooms',              'rooms.json',             null],
];

const human = (n) => n.toLocaleString();

(async () => {
  const client = new MongoClient(process.env.MONGO_URI, { useUnifiedTopology: true });
  await client.connect();

  const manifest = {};
  for (const [db, col, file, projection] of PULLS) {
    const cursor = client.db(db).collection(col).find({}, projection ? { projection } : {});
    const docs = await cursor.toArray();
    const dest = path.join(OUT, file);
    fs.writeFileSync(dest, JSON.stringify(docs));
    const kb = Math.round(fs.statSync(dest).size / 1024);
    manifest[file] = { db, collection: col, docs: docs.length, kb, redacted: !!projection };
    console.log(`  ${String(docs.length).padStart(8)}  ${file.padEnd(24)} ${String(kb).padStart(6)}KB${projection ? '  (fields limited)' : ''}`);
  }

  // ── the join ────────────────────────────────────────────────────────────
  // Emitted as JSONL so a 1GB file streams instead of needing to be parsed
  // whole, and so a buyer can pipe it without loading it.
  console.log('\n  joining tags onto rounds...');
  const rawRounds = JSON.parse(fs.readFileSync(path.join(OUT, 'rounds.json'), 'utf8'));
  const tagged = fs.createWriteStream(path.join(OUT, 'rounds-tagged.jsonl'));
  const cov = { rounds: 0, blackSeen: 0, blackTagged: 0, playedCards: 0, playedTagged: 0,
                handCards: 0, handTagged: 0, heatPlayed: {}, heatWon: {}, flavors: {} };
  const bump = (o, k) => { if (k != null && k !== '') o[k] = (o[k] || 0) + 1; };

  for (const r of rawRounds) {
    cov.rounds++;
    let promptTag = null;
    if (r.blackCard && r.blackCard.id) {
      cov.blackSeen++;
      // Signal prompts live in the resolved set, not prompt-tags-v1. Checking
      // only the latter reported 83.9% when the true coverage is total.
      promptTag = TAG_PR[r.blackCard.id] || tagOf(r.blackCard.id) || null;
      if (promptTag) cov.blackTagged++;
    }
    const winners = new Set(Array.isArray(r.winner) ? r.winner : [r.winner]);
    const submissions = (r.submissions || []).map((sub) => {
      const won = winners.has(sub.player);
      const cards = (sub.cards || []).map((c) => {
        cov.playedCards++;
        const t = tagOf(c.id);
        if (t) {
          cov.playedTagged++;
          // Rando is a bot; its plays are not human preference.
          if (!sub.isRando) {
            bump(cov.heatPlayed, t.heat);
            if (won) bump(cov.heatWon, t.heat);
            for (const f of t.flavors || []) {
              const o = cov.flavors[f] || (cov.flavors[f] = { played: 0, won: 0 });
              o.played++; if (won) o.won++;
            }
          }
        }
        return { ...c, tags: t };
      });
      return { ...sub, won, cards };
    });
    // Hands are the rejected alternatives: the contrastive half, and the part
    // an unlabelled corpus throws away.
    const hands = {};
    for (const [pl, ids] of Object.entries(r.hands || {})) {
      hands[pl] = (ids || []).map((id) => {
        cov.handCards++;
        const t = tagOf(id);
        if (t) cov.handTagged++;
        return { id, tags: t };
      });
    }
    tagged.write(JSON.stringify({
      ts: r.ts, gameId: r.gameId, turn: r.turn, outcome: r.outcome,
      tagset: (r.context || {}).tagset || null,
      blackCard: r.blackCard ? { ...r.blackCard, tags: promptTag } : null,
      submissions, hands, players: r.players,
    }) + '\n');
  }
  await new Promise((res) => tagged.end(res));

  const rate = (a, b) => (b ? +(100 * a / b).toFixed(1) : null);
  const tagCoverage = {
    playedCardsTaggedPct: rate(cov.playedTagged, cov.playedCards),
    handCardsTaggedPct: rate(cov.handTagged, cov.handCards),
    blackCardsTaggedPct: rate(cov.blackTagged, cov.blackSeen),
    playedCards: cov.playedCards, handCards: cov.handCards,
    heatWinRate: Object.fromEntries(Object.keys(cov.heatPlayed).sort().map((h) => [h, {
      played: cov.heatPlayed[h], won: cov.heatWon[h] || 0,
      winRate: rate(cov.heatWon[h] || 0, cov.heatPlayed[h]),
    }])),
    flavorWinRate: Object.fromEntries(Object.entries(cov.flavors).map(([f, o]) => [f, {
      played: o.played, won: o.won, winRate: rate(o.won, o.played),
    }])),
  };
  console.log(`  played cards tagged  ${tagCoverage.playedCardsTaggedPct}%`);
  console.log(`  hand cards tagged    ${tagCoverage.handCardsTaggedPct}%   (${cov.handTagged.toLocaleString()} observations)`);
  console.log(`  black cards tagged   ${tagCoverage.blackCardsTaggedPct}%`);

  // Headline figures, computed here so the numbers in any deck trace to a file.
  const g = client.db('games');
  const rounds = g.collection('round_analytics');
  const total = await rounds.countDocuments({});
  const outcomes = await rounds.aggregate([{ $group: { _id: '$outcome', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
  const first = await rounds.find({}).sort({ ts: 1 }).limit(1).toArray();
  const last  = await rounds.find({}).sort({ ts: -1 }).limit(1).toArray();
  const games = await rounds.distinct('gameId');
  // Rationales are nested under signals.czarReasoning, not a top-level field.
  // Querying the wrong path silently returned 0, which would have quietly
  // contradicted the figure already printed in the Domino's one-pager.
  const REASON = { 'signals.czarReasoning.text': { $exists: true, $nin: [null, ''] } };
  const withReasoning = await rounds.countDocuments(REASON);
  const reasoningVerdicts = await rounds.aggregate([
    { $match: REASON },
    { $group: { _id: '$signals.czarReasoning.verdict', n: { $sum: 1 }, avgScore: { $avg: '$signals.czarReasoning.score' } } },
    { $sort: { n: -1 } },
  ]).toArray();

  const winners = outcomes.find((o) => o._id === 'winner');
  const judged = winners ? winners.n : 0;

  const summary = {
    pulledAt: new Date().toISOString(),
    rounds: total,
    judgedRounds: judged,
    distinctGames: games.length,
    firstRoundAt: first[0] && first[0].ts,
    lastRoundAt: last[0] && last[0].ts,
    outcomes,
    roundsWithWrittenReasoning: withReasoning,
    reasoningVerdicts,
    impressions: await g.collection('signal_impressions').countDocuments({}),
    leaderboardEntries: await g.collection('humor_leaderboard').countDocuments({}),
    wyrResponses: await g.collection('wyr_responses').countDocuments({}),
    totResponses: await g.collection('tot_responses').countDocuments({}),
    players: await client.db('clients').collection('clients').countDocuments({}),
    optedInPlayers: await client.db('clients').collection('clients').countDocuments({ marketingOptIn: true }),
    rooms: await client.db('rooms').collection('rooms').countDocuments({}),
    liveDonations: await client.db('clients').collection('donations').countDocuments({ livemode: true }),
    tagCoverage,
    manifest,
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n  ---');
  console.log(`  rounds            ${human(summary.rounds)}   (judged: ${human(summary.judgedRounds)})`);
  console.log(`  distinct games    ${human(summary.distinctGames)}`);
  console.log(`  written rationales${String(human(summary.roundsWithWrittenReasoning)).padStart(9)}`);
  console.log(`  impressions       ${human(summary.impressions)}`);
  console.log(`  players           ${human(summary.players)}   (opted in: ${human(summary.optedInPlayers)})`);
  console.log(`  window            ${new Date(summary.firstRoundAt).toISOString().slice(0,10)} -> ${new Date(summary.lastRoundAt).toISOString().slice(0,10)}`);

  await client.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
