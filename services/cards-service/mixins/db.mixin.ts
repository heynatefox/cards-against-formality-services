import DbService from 'moleculer-db';
import MongoAdapter from 'moleculer-db-adapter-mongo';

export default function (collection) {
  return {
    name: 'db-service',
    mixins: [DbService],
    adapter: new MongoAdapter(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true }),
    collection
  };
}