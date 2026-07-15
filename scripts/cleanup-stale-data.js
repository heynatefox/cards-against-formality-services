/**
 * One-shot / cron cleanup for data that accumulates forever:
 *
 * 1. Anonymous client records — every guest visit creates an `Anon-xxxx`
 *    client. The disconnect flow deletes them, but records leak whenever a
 *    socket never connects (bounced visitors) or the process restarts.
 * 2. Stale rooms — rooms whose players all vanished stay in the lobby list
 *    indefinitely (the public list shows locked rooms from months ago).
 *
 * Rooms/clients have no createdAt field, so a Mongo TTL index isn't an
 * option — this uses the ObjectId timestamp instead.
 *
 * Usage:  MONGO_URI="mongodb://..." node scripts/cleanup-stale-data.js [--dry-run]
 * Suggested: run daily (Railway cron or GitHub Action).
 */
const { MongoClient, ObjectId } = require('mongodb');

const STALE_DAYS = 7;

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  const dryRun = process.argv.includes('--dry-run');

  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
  const cutoffId = ObjectId.createFromTime(Math.floor(cutoff.getTime() / 1000));

  const client = new MongoClient(uri);
  await client.connect();

  try {
    const rooms = client.db('rooms').collection('rooms');
    const clients = client.db('clients').collection('clients');

    // Rooms older than the cutoff with nobody in them
    const staleRoomFilter = { _id: { $lt: cutoffId }, players: { $size: 0 } };
    // Anonymous clients older than the cutoff that aren't in a room
    const staleClientFilter = {
      isAnonymous: true,
      roomId: { $in: [null, undefined] },
      // client _id is the Firebase uid (a string), so age-check via disconnectedAt
      $or: [{ disconnectedAt: { $lt: cutoff.getTime() } }, { socket: { $in: [null, undefined] } }],
    };

    if (dryRun) {
      console.log('[dry-run] stale rooms:', await rooms.countDocuments(staleRoomFilter));
      console.log('[dry-run] stale anon clients:', await clients.countDocuments(staleClientFilter));
      return;
    }

    const r = await rooms.deleteMany(staleRoomFilter);
    const c = await clients.deleteMany(staleClientFilter);
    console.log(`Deleted ${r.deletedCount} stale rooms, ${c.deletedCount} stale anon clients`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
