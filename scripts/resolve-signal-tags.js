/**
 * Insert the Signal payload cards into the live cards collection (idempotent,
 * matched by text — same contract as ensureSignalCards) and regenerate
 * src/data/signal-tags-resolved.json, the live-ObjectId → tag map that feeds
 * the solo probe pool and the offline extract join.
 *
 * Usage: MONGO_URI="mongodb://...proxy.../games" node scripts/resolve-signal-tags.js
 */
const fs = require('fs');
const path = require('path');
const { MongoClient } = require(path.join(__dirname, '..', 'services', 'clients-service', 'node_modules', 'mongodb'));

const PAYLOAD = path.join(__dirname, '..', 'services', 'games-service', 'src', 'data', 'signal-cards-v1.json');
const OUT = path.join(__dirname, '..', 'services', 'games-service', 'src', 'data', 'signal-tags-resolved.json');

async function main() {
  if (!process.env.MONGO_URI) { throw new Error('MONGO_URI required'); }
  const payload = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8')).cards;
  const client = new MongoClient(process.env.MONGO_URI, { useUnifiedTopology: true });
  await client.connect();
  // The cards service owns db 'cards'. (games.cards is a stale pre-signal
  // copy kept only for old extract joins; never write there.)
  const cards = client.db('cards').collection('cards');

  // 1. Insert whatever the service hasn't already (idempotent by text).
  const texts = payload.map(p => p.text);
  const existing = await cards.find({ text: { $in: texts } }).toArray();
  const byText = {};
  existing.forEach(c => { byText[c.text] = c; });
  const missing = payload.filter(p => !byText[p.text]);
  if (missing.length) {
    const docs = missing.map(p => (p.cardType === 'black'
      ? { text: p.text, cardType: 'black', pick: p.pick || 1 }
      : { text: p.text, cardType: 'white' }));
    const res = await cards.insertMany(docs);
    Object.values(res.insertedIds).forEach((id, i) => { byText[missing[i].text] = { _id: id, ...docs[i] }; });
    console.log(`inserted ${missing.length} new cards`);
  } else {
    console.log('all payload cards already live');
  }

  // 2. Resolved map: live id -> everything the pool and the extract need.
  const resolved = {};
  let ladders = 0, trios = 0;
  for (const p of payload) {
    const live = byText[p.text];
    if (!live) { console.warn(`UNRESOLVED: ${p.source_id}`); continue; }
    const sig = p.signal || {};
    const entry = {
      src: p.source_id,
      cardType: p.cardType,
      h: sig.heat,
      cls: sig.class,
      measures: sig.measures || null,
    };
    if (sig.amp != null) { entry.amp = sig.amp; }
    // Wave-2 fields: full axis vectors and the instrument groupings.
    if (sig.axes) { entry.m = sig.axes.m; entry.r = sig.axes.r; entry.s = sig.axes.s; }
    if (sig.flavors && sig.flavors.length) { entry.f = sig.flavors; }
    if (sig.ladder) { entry.ladder = sig.ladder; ladders++; }
    if (sig.paraphrase) { entry.paraphrase = sig.paraphrase; trios++; }
    resolved[String(live._id)] = entry;
  }
  fs.writeFileSync(OUT, JSON.stringify(resolved, null, 1));
  console.log(`resolved ${Object.keys(resolved).length} cards (${ladders} ladder rungs, ${trios} paraphrase variants) -> ${path.basename(OUT)}`);
  await client.close();
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
