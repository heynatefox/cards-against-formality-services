// Runtime registry for the Signal candidate decks (measurement pilot wave 1).
// Populated at service startup by games-service.ensureSignalCards(): the 252
// authored candidates are inserted into the cards DB (matched by text, so the
// import is idempotent) and their live ObjectIds land here. The dealer injects
// candidates from this registry; until it's ready, dealing is unaffected.

export interface SignalMeta {
  sourceId: string;
  cardType: 'white' | 'black';
  pick?: number;
  signal: any;
}

export const signalRegistry = {
  ready: false,
  whiteIds: [] as string[],          // injectable candidate responses (heat <= 4)
  promptIds: new Set<string>(),      // signal prompts (all fork-eligible)
  metaById: {} as { [id: string]: SignalMeta },
};
