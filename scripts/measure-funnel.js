#!/usr/bin/env node
/**
 * Fundraiser funnel: impressions -> clicks -> donations, per placement.
 *
 * "/measure got 40 views" says nothing on its own. Forty views off four
 * hundred banner impressions is a healthy call to action; forty off four
 * thousand is a dead one. This prints the rate, not the raw count.
 *
 *   MONGO_URI=... node scripts/measure-funnel.js [days]
 *
 * Reads promo_events (property: 'measure') from the games db and donations
 * from the clients db. Both are written by production; nothing here writes.
 */
// The driver is not a root dependency; it lives inside each service. Resolve
// it from one of those so this runs from anywhere without an npm install.
const path = require('path');
const { MongoClient } = (() => {
  const candidates = [
    'mongodb',
    path.join(__dirname, '..', 'services', 'clients-service', 'node_modules', 'mongodb'),
    path.join(__dirname, '..', 'services', 'games-service', 'node_modules', 'mongodb'),
  ];
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* try the next one */ }
  }
  console.error('Could not find the mongodb driver in any service.');
  process.exit(1);
})();

const DAYS = Number(process.argv[2] || 7);
const SINCE = Date.now() - DAYS * 24 * 3600 * 1000;
const PLACEMENTS = ['hero', 'banner', 'nav', 'home', 'endgame'];

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '–');
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

(async () => {
  const client = new MongoClient(process.env.MONGO_URI, { useUnifiedTopology: true });
  await client.connect();

  const events = client.db('games').collection('promo_events');
  const donations = client.db('clients').collection('donations');

  const rows = await events.aggregate([
    { $match: { property: 'measure', ts: { $gte: SINCE } } },
    { $group: { _id: { p: '$placement', t: '$type' }, n: { $sum: 1 } } },
  ]).toArray();

  const tally = {};
  for (const p of PLACEMENTS) tally[p] = { impression: 0, click: 0, donations: 0, dollars: 0 };
  for (const r of rows) {
    const p = r._id.p;
    if (tally[p]) tally[p][r._id.t] = r.n;
  }

  // Only live money counts. Test-mode rows would flatter every rate.
  for (const d of await donations.find({ ts: { $gte: SINCE }, livemode: true }).toArray()) {
    const from = d.from && tally[d.from] ? d.from : null;
    if (from) {
      tally[from].donations += 1;
      tally[from].dollars += (d.amountCents || 0) / 100;
    }
  }

  const untagged = await donations.countDocuments({
    ts: { $gte: SINCE }, livemode: true,
    $or: [{ from: { $exists: false } }, { from: '' }, { from: null }],
  });

  console.log(`\nFUNDRAISER FUNNEL · last ${DAYS} day(s)\n`);
  console.log(`  ${pad('PLACEMENT', 10)} ${lpad('SEEN', 8)} ${lpad('CLICKS', 8)} ${lpad('CTR', 8)} ${lpad('GAVE', 6)} ${lpad('CONV', 8)} ${lpad('$', 9)}`);
  console.log(`  ${'-'.repeat(62)}`);

  let tI = 0, tC = 0, tD = 0, tM = 0;
  for (const p of PLACEMENTS) {
    const v = tally[p];
    tI += v.impression; tC += v.click; tD += v.donations; tM += v.dollars;
    console.log(`  ${pad(p, 10)} ${lpad(v.impression, 8)} ${lpad(v.click, 8)} ${lpad(pct(v.click, v.impression), 8)} ${lpad(v.donations, 6)} ${lpad(pct(v.donations, v.click), 8)} ${lpad('$' + v.dollars.toFixed(2), 9)}`);
  }
  console.log(`  ${'-'.repeat(62)}`);
  console.log(`  ${pad('TOTAL', 10)} ${lpad(tI, 8)} ${lpad(tC, 8)} ${lpad(pct(tC, tI), 8)} ${lpad(tD, 6)} ${lpad(pct(tD, tC), 8)} ${lpad('$' + tM.toFixed(2), 9)}`);

  if (untagged) {
    console.log(`\n  ${untagged} live donation(s) carried no placement tag.`);
    console.log('  Expected for anything before the CTAs shipped, or arriving straight');
    console.log('  from measuringdicks.com, which has no placement to report.');
  }

  console.log('\n  SEEN counts CTA impressions, not site sessions. A low CTR means the');
  console.log('  wording is weak; a low CONV means the page is. They are different');
  console.log('  problems and this is the only view that separates them.\n');

  // ── Hero slot A/B: fundraiser vs Hot or Cold ──────────────────────────

  // Both arms render in the same slot and log to promo_events under their

  // own property, so CTR is computed against each arm's own impressions.

  const heroRows = await events.aggregate([

    { $match: { placement: 'hero', ts: { $gte: SINCE } } },

    { $group: { _id: { prop: '$property', t: '$type' }, n: { $sum: 1 } } },

  ]).toArray();

  const arms = { measure: { impression: 0, click: 0 }, hotorcold: { impression: 0, click: 0 } };

  for (const r of heroRows) {

    const a = arms[r._id.prop];

    if (a) a[r._id.t] = r.n;

  }

  if (arms.hotorcold.impression || arms.hotorcold.click) {

    console.log('\n  HERO SLOT A/B · same button, re-rolled per visit\n');

    console.log('  ARM                 SEEN   CLICKS      CTR');

    console.log('  ------------------------------------------');

    for (const [name, label] of [['measure', 'measure your dick'], ['hotorcold', 'hot or cold']]) {

      const a = arms[name];

      console.log('  ' + pad(label, 18) + lpad(a.impression, 6) + lpad(a.click, 9) + lpad(pct(a.click, a.impression), 9));

    }

    const mC = pct(arms.measure.click, arms.measure.impression);

    const hC = pct(arms.hotorcold.click, arms.hotorcold.impression);

    console.log('\n  Clicks are the metric here, not dollars: the arms go to');

    console.log('  different places, so only the CTR is comparable (' + mC + ' vs ' + hC + ').');

  } else {

    console.log('\n  Hero A/B: no Hot or Cold arm impressions yet.');

  }


  // ── Page framing A/B: vanity vs support ───────────────────────────────


  // Conversion is the metric here, not clicks: both arms are the same page


  // reached the same way, so the only question is which ask gets paid.


  const copyRows = await events.aggregate([


    { $match: { property: 'measure-copy', ts: { $gte: SINCE } } },


    { $group: { _id: { arm: '$variant', t: '$type' }, n: { $sum: 1 } } },


  ]).toArray();


  const copyArms = { vanity: { impression: 0, click: 0, gave: 0, dollars: 0 },


                    support: { impression: 0, click: 0, gave: 0, dollars: 0 } };


  for (const r of copyRows) {


    const a = copyArms[r._id.arm];


    if (a) a[r._id.t] = r.n;


  }


  for (const d of await donations.find({ ts: { $gte: SINCE }, livemode: true, seed: { $ne: true } }).toArray()) {


    const a = copyArms[d.copy];


    if (a) { a.gave += 1; a.dollars += (d.inches || 0); }


  }


  if (copyArms.vanity.impression || copyArms.support.impression) {


    console.log('\n  PAGE FRAMING A/B · same page, re-rolled per visit\n');


    console.log('  ARM        SEEN  REACHED PAY     GAVE          $');


    console.log('  ------------------------------------------------');


    for (const [name, label] of [['vanity', 'vanity'], ['support', 'support']]) {


      const a = copyArms[name];


      console.log('  ' + pad(label, 9) + lpad(a.impression, 6) + lpad(a.click, 9)


        + lpad(pct(a.click, a.impression), 8) + lpad(a.gave, 5) + lpad('$' + a.dollars.toFixed(2), 11));


    }


    console.log('\n  SEEN is page views of that framing. REACHED PAY is people who');


    console.log('  pressed the button. GAVE is money that actually arrived.');


  } else {


    console.log('\n  Page framing A/B: no impressions yet.');


  }



  await client.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
