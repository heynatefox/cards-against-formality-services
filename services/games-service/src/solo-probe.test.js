/**
 * Tests for solo probe selection, run against the REAL tag catalogues rather
 * than fixtures. A selector that works on invented cards and falls over on the
 * live deck is worth nothing, and the live deck is what it will see.
 *
 *   node solo-probe.test.js
 */
const fs = require('fs');
const path = require('path');
// Compile the TS on demand so the test needs no build step and no committed
// artifact sitting next to the source going stale.
const { execSync } = require('child_process');
const BUILT = '/tmp/solo-probe-build';
execSync(`npx tsc --target es2017 --module commonjs --outDir ${BUILT} ${__dirname}/solo-probe.ts`,
         { stdio: 'pipe' });
const {
  AXES, emptyProfile, uncertainty, nextAxis, contrastScore,
  selectProbe, updateProfile, describeRound,
} = require(`${BUILT}/solo-probe.js`);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '   ' + detail : ''}`); }
};

// ── load the live deck ──────────────────────────────────────────────────────
const DATA = __dirname + '/data';
const v2 = JSON.parse(fs.readFileSync(path.join(DATA, 'card-tags-v2.json'), 'utf8'));
const v1 = JSON.parse(fs.readFileSync(path.join(DATA, 'card-tags-v1.json'), 'utf8'));
const sig = JSON.parse(fs.readFileSync(path.join(DATA, 'signal-tags-resolved.json'), 'utf8'));

const pool = [];
for (const [id, t] of Object.entries(v2)) {
  const b = v1[id] || {};
  pool.push({ id, text: '', tags: {
    heat: t.h, mode: t.m, register: t.r, sincerity: t.s,
    flavors: t.f, cls: t.cls, edge: b.e,
  } });
}
for (const [id, g] of Object.entries(sig)) {
  pool.push({ id, text: '', tags: {
    heat: g.h, cls: g.cls,
    measuresPrimary: g.measures && g.measures.primary,
  } });
}
console.log(`\npool: ${pool.length} cards (${Object.keys(sig).length} authored probes)\n`);

// ── uncertainty and axis choice ─────────────────────────────────────────────
const p0 = emptyProfile();
ok('fresh profile is maximally uncertain', uncertainty(p0, 'heat') === 1);

let p = updateProfile(p0, 'heat', { heat: 4 });
ok('an observation reduces uncertainty', uncertainty(p, 'heat') < uncertainty(p0, 'heat'));
ok('and only on the axis observed', uncertainty(p, 'mode') === 1);
ok('next axis avoids the one just measured', nextAxis(p) !== 'heat');

// Asking the same axis repeatedly must eventually yield to the others.
let p2 = emptyProfile();
for (let i = 0; i < 5; i++) p2 = updateProfile(p2, 'heat', { heat: 3 });
ok('a well-measured axis stops being chosen', nextAxis(p2) !== 'heat');

// ── running mean ────────────────────────────────────────────────────────────
let p3 = emptyProfile();
for (const v of [1, 2, 3]) p3 = updateProfile(p3, 'heat', { heat: v });
ok('running mean is correct', Math.abs(p3.mean.heat - 2) < 1e-9, `got ${p3.mean.heat}`);
ok('observation count tracks', p3.n.heat === 3);
const p4 = updateProfile(p3, 'heat', {});   // no value on the axis
ok('a card with no value on the axis is ignored', p4.n.heat === 3);

// ── contrast scoring ────────────────────────────────────────────────────────
const wide  = contrastScore({ heat: 1, mode: 0, register: 0, sincerity: 0 },
                            { heat: 5, mode: 0, register: 0, sincerity: 0 }, 'heat');
const narrow = contrastScore({ heat: 2, mode: 0, register: 0, sincerity: 0 },
                             { heat: 3, mode: 0, register: 0, sincerity: 0 }, 'heat');
ok('wider separation scores higher', wide > narrow);

const clean = contrastScore({ heat: 1, mode: 0, register: 0, sincerity: 0 },
                            { heat: 5, mode: 0, register: 0, sincerity: 0 }, 'heat');
const confounded = contrastScore({ heat: 1, mode: -5, register: -5, sincerity: -3 },
                                 { heat: 5, mode: 3, register: 2, sincerity: 4 }, 'heat');
ok('a confounded pair scores below a clean one', clean > confounded,
   `clean ${clean.toFixed(2)} vs confounded ${confounded.toFixed(2)}`);
ok('an unmeasurable axis is rejected',
   contrastScore({ heat: 1 }, { mode: 2 }, 'register') === -Infinity);

// ── selection against the live deck ─────────────────────────────────────────
for (const axis of AXES) {
  const probe = selectProbe(pool, emptyProfile(), 2, axis);
  ok(`selects a pair for ${axis}`, !!probe && probe.cards.length === 2);
  if (probe) {
    const [a, b] = probe.cards;
    const sep = Math.abs(a.tags[axis] - b.tags[axis]);
    ok(`  ${axis}: the pair actually separates (${sep})`, sep > 0);
    ok(`  ${axis}: reports the axis it measured`, probe.axis === axis);
  }
}

const three = selectProbe(pool, emptyProfile(), 3, 'heat');
ok('honours a larger bot count', !!three && three.cards.length === 3);
const distinct = three && new Set(three.cards.map((c) => c.id)).size === three.cards.length;
ok('never plays the same card twice in one round', !!distinct);

ok('returns null when the pool cannot support a round',
   selectProbe([pool[0]], emptyProfile(), 2, 'heat') === null);

// ── the corpus contract ─────────────────────────────────────────────────────
const probe = selectProbe(pool, emptyProfile(), 2, 'mode');
const signal = describeRound(probe, probe.cards[0].id, 1400);
ok('round is marked human-judged', signal.judgedBy === 'human');
ok('round is marked solo', signal.mode === 'solo');
ok('exactly one option wins', signal.options.filter((o) => o.won).length === 1);
ok('every option carries its tags', signal.options.every((o) => o.tags && Object.keys(o.tags).length));
ok('the tested axis is recorded', signal.contrastAxis === 'mode');

// ── it must converge, not wander ────────────────────────────────────────────
// Simulate a player who reliably prefers absurd cards and check the profile
// finds that rather than drifting.
let sim = emptyProfile();
for (let round = 0; round < 24; round++) {
  const pr = selectProbe(pool, sim, 2);
  if (!pr) break;
  const [x, y] = pr.cards;
  const pick = pr.axis === 'mode'
    ? ((x.tags.mode ?? 0) > (y.tags.mode ?? 0) ? x : y)   // always the more absurd
    : x;
  sim = updateProfile(sim, pr.axis, pick.tags);
}
ok('every axis gets measured within 24 rounds',
   AXES.every((a) => (sim.n[a] || 0) > 0), JSON.stringify(sim.n));
ok('detects a preference for absurd', (sim.mean.mode ?? -99) > 0,
   `mode mean ${sim.mean.mode}`);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
