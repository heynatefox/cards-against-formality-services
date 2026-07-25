const { MongoClient } = require('mongodb');
const json = require('./cards.json');

const MONGO_HOST = process.env.MONGODB_HOST;
if (!MONGO_HOST) {
  console.error('ERROR: Set MONGODB_HOST (e.g. mongodb://interchange.proxy.rlwy.net:24848)');
  process.exit(1);
}

async function run() {
  const client = await MongoClient.connect(MONGO_HOST, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log('Connected to MongoDB');

  // Services use separate databases matching their service name:
  // cards-service -> 'cards' db, decks-service -> 'decks' db
  const cardsDb = client.db('cards');
  const decksDb = client.db('decks');
  const cardsCol = cardsDb.collection('cards');
  const decksCol = decksDb.collection('decks');

  // Clear existing data
  const deletedCards = await cardsCol.deleteMany({});
  const deletedDecks = await decksCol.deleteMany({});
  console.log(`Cleared ${deletedCards.deletedCount} cards, ${deletedDecks.deletedCount} decks`);

  // Prepare card documents
  const { blackCards, whiteCards, order, ...deckDefs } = json;

  const blackDocs = blackCards.map(card => ({ text: card.text, cardType: 'black', pick: card.pick }));
  const whiteDocs = whiteCards.map(text => ({ text, cardType: 'white' }));

  // Insert all cards
  console.log(`Inserting ${blackDocs.length} black cards...`);
  const blackResult = await cardsCol.insertMany(blackDocs);
  const blackIds = Object.values(blackResult.insertedIds);
  console.log(`  Inserted ${blackIds.length} black cards`);

  console.log(`Inserting ${whiteDocs.length} white cards...`);
  const whiteResult = await cardsCol.insertMany(whiteDocs);
  const whiteIds = Object.values(whiteResult.insertedIds);
  console.log(`  Inserted ${whiteIds.length} white cards`);

  // Build and insert decks (references point to card _ids in cards db)
  const deckNames = order || Object.keys(deckDefs);
  console.log(`\nCreating ${deckNames.length} decks...`);

  for (const key of deckNames) {
    const deck = deckDefs[key];
    if (!deck) {
      console.log(`  Skipping unknown deck key: ${key}`);
      continue;
    }

    const deckDoc = {
      name: deck.name,
      blackCards: (deck.black || []).map(idx => blackIds[idx]).filter(Boolean),
      whiteCards: (deck.white || []).map(idx => whiteIds[idx]).filter(Boolean),
    };

    await decksCol.insertOne(deckDoc);
    console.log(`  ${deck.name}: ${deckDoc.blackCards.length} black, ${deckDoc.whiteCards.length} white`);
  }

  console.log(`\nDone! ${blackIds.length + whiteIds.length} cards in 'cards' db, ${deckNames.length} decks in 'decks' db.`);
  await client.close();
}

run().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
