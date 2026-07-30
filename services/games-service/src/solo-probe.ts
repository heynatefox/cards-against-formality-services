/**
 * Solo mode: adaptive probe selection.
 *
 * ── The design decision, and why ──────────────────────────────────────────
 *
 * The obvious solo design is "bots fill the empty seats and one of them judges
 * when it is their turn". That is the wrong build. The winner of a round IS the
 * preference signal, the whole reason this corpus is worth anything, and a bot
 * verdict manufactures a labelled preference no human ever expressed. Ship that
 * and synthetic judgments land in the same collection as 199,130 real ones,
 * indistinguishable at analysis time.
 *
 * So in solo mode the human is ALWAYS the Card Czar. Bots only ever play cards;
 * they never judge. Consequences:
 *
 *   - No synthetic verdict is ever written. The corpus stays clean by
 *     construction rather than by remembering to filter.
 *   - Every round is a real human judgment over a choice set WE controlled,
 *     which is strictly better evidence than a random hand. A table deals what
 *     it happens to deal; here we choose what to ask.
 *   - It is a coherent game rather than a compromise. You are the judge, the
 *     bots compete for your approval, and you say who was funniest.
 *
 * ── What the bots play ────────────────────────────────────────────────────
 *
 * Not random. Rando Cardrissian already plays random cards and teaches us
 * nothing. Each round is built as a PAIRED COMPARISON on a single axis: two
 * cards matched as closely as possible on every dimension except the one being
 * measured, so the pick is attributable to that axis instead of confounded
 * across four of them.
 *
 * The axis chosen each round is whichever the player's profile is least certain
 * about, so the round is worth the most information. That is active learning:
 * ask the question whose answer you cannot already predict.
 */

/** The four taste axes carried by card-tags-v1/v2. */
export type Axis = 'heat' | 'mode' | 'register' | 'sincerity';
export const AXES: Axis[] = ['heat', 'mode', 'register', 'sincerity'];

export interface CardTags {
  heat?: number;       // 1..5   transgression
  mode?: number;       // -5..+3 grounded (neg) .. absurd (pos)
  register?: number;   // -5..+2 low .. high register
  sincerity?: number;  // -3..+4 ironic .. sincere
  flavors?: string[];
  cls?: string;        // 'filler' | 'probe'
  measuresPrimary?: string;
}

export interface TaggedCard {
  id: string;
  text: string;
  tags: CardTags;
}

/**
 * Running estimate of one player's taste. `n` is how many observations back
 * each axis, which is what makes uncertainty meaningful rather than assumed.
 */
export interface TasteProfile {
  mean: { [K in Axis]?: number };
  n: { [K in Axis]?: number };
}

export const emptyProfile = (): TasteProfile => ({ mean: {}, n: {} });

/**
 * Uncertainty on an axis. Falls as observations accumulate, so a fresh player
 * is uncertain everywhere and every axis is worth asking about; a veteran is
 * only worth asking about whatever still moves.
 *
 * 1/sqrt(n+1) rather than a full posterior: the ranking is all that matters
 * here, and this needs no distributional assumptions to defend to a buyer.
 */
export function uncertainty(p: TasteProfile, axis: Axis): number {
  return 1 / Math.sqrt((p.n[axis] || 0) + 1);
}

/** The axis worth asking about this round. Ties break in AXES order. */
export function nextAxis(p: TasteProfile): Axis {
  let best: Axis = AXES[0];
  let bestU = -1;
  for (const a of AXES) {
    const u = uncertainty(p, a);
    if (u > bestU) { bestU = u; best = a; }
  }
  return best;
}

/** Observed spread per axis, used to normalise distances across axes. */
const RANGE: { [K in Axis]: number } = { heat: 4, mode: 8, register: 7, sincerity: 7 };

/**
 * How well a pair isolates `axis`: far apart on it, close on everything else.
 *
 * Separation is squared so a genuinely wide contrast is worth much more than
 * two mediocre ones, and confounds are subtracted rather than divided so a pair
 * that differs on everything scores badly instead of merely unremarkably.
 */
export function contrastScore(a: CardTags, b: CardTags, axis: Axis): number {
  const av = a[axis], bv = b[axis];
  if (av == null || bv == null) return -Infinity;   // cannot measure it

  const separation = Math.abs(av - bv) / RANGE[axis];
  let confound = 0;
  let counted = 0;
  for (const other of AXES) {
    if (other === axis) continue;
    const ao = a[other], bo = b[other];
    if (ao == null || bo == null) continue;
    confound += Math.abs(ao - bo) / RANGE[other];
    counted++;
  }
  const meanConfound = counted ? confound / counted : 0;
  return separation * separation - meanConfound;
}

export interface Probe {
  axis: Axis;
  cards: TaggedCard[];   // what the bots will play, in order
  score: number;
  /** True when at least one side is an authored probe card. */
  authored: boolean;
}

/**
 * Choose what the bots play this round.
 *
 * Authored probe cards (cls === 'probe') are preferred where they exist: they
 * were written to test a named axis and carry `measuresPrimary` saying which,
 * so a pick against them is interpretable rather than merely correlated.
 */
export function selectProbe(
  pool: TaggedCard[],
  profile: TasteProfile,
  botCount = 2,
  axis: Axis = nextAxis(profile),
): Probe | null {
  const usable = pool.filter((c) => c.tags && c.tags[axis] != null);
  if (usable.length < botCount) return null;

  // Authored probes for this axis first, then the rest, so the search
  // prioritises interpretable pairs without excluding the deck.
  const onAxis = (c: TaggedCard) =>
    c.tags.cls === 'probe' && (c.tags.measuresPrimary || '').startsWith(axis);
  const ranked = [...usable].sort((a, b) => Number(onAxis(b)) - Number(onAxis(a)));

  // Cap the search: the pool is ~2,800 cards and an exhaustive pairwise pass
  // runs every round of every solo game.
  const head = ranked.slice(0, 240);

  let best: { a: TaggedCard; b: TaggedCard; s: number } | null = null;
  for (let i = 0; i < head.length; i++) {
    for (let j = i + 1; j < head.length; j++) {
      const s = contrastScore(head[i].tags, head[j].tags, axis);
      if (!best || s > best.s) best = { a: head[i], b: head[j], s };
    }
  }
  if (!best) return null;

  const cards = [best.a, best.b];
  // More than two bots: fill the remaining seats with the widest spread still
  // available on this axis, so the extra seats add range instead of noise.
  if (botCount > 2) {
    const chosen = new Set(cards.map((c) => c.id));
    const rest = usable
      .filter((c) => !chosen.has(c.id))
      .sort((x, y) => Math.abs((y.tags[axis] as number) - (best!.a.tags[axis] as number))
                    - Math.abs((x.tags[axis] as number) - (best!.a.tags[axis] as number)));
    cards.push(...rest.slice(0, botCount - 2));
  }

  return {
    axis,
    cards,
    score: best.s,
    authored: cards.some(onAxis),
  };
}

/**
 * Fold the czar's verdict back into the profile.
 *
 * The winner's value on the tested axis is the observation. Losers are not
 * treated as evidence against: in a paired comparison the loser is only
 * "less preferred here", not disliked, and counting it twice would double the
 * weight of a single decision.
 */
export function updateProfile(
  profile: TasteProfile,
  axis: Axis,
  winner: CardTags,
): TasteProfile {
  const v = winner[axis];
  if (v == null) return profile;
  const n = (profile.n[axis] || 0) + 1;
  const prev = profile.mean[axis];
  const mean = prev == null ? v : prev + (v - prev) / n;   // running mean
  return {
    mean: { ...profile.mean, [axis]: mean },
    n: { ...profile.n, [axis]: n },
  };
}

/**
 * What a solo round contributes to the corpus.
 *
 * `judgedBy: 'human'` is the load-bearing field. It is always human in this
 * mode by construction, and it is written explicitly so an export can prove
 * that rather than infer it from the absence of a bot flag.
 */
export interface SoloRoundSignal {
  mode: 'solo';
  judgedBy: 'human';
  contrastAxis: Axis;
  contrastScore: number;
  authoredProbe: boolean;
  options: Array<{ id: string; tags: CardTags; won: boolean }>;
  decisionMs?: number;
}

export function describeRound(probe: Probe, winnerId: string, decisionMs?: number): SoloRoundSignal {
  return {
    mode: 'solo',
    judgedBy: 'human',
    contrastAxis: probe.axis,
    contrastScore: probe.score,
    authoredProbe: probe.authored,
    options: probe.cards.map((c) => ({ id: c.id, tags: c.tags, won: c.id === winnerId })),
    decisionMs,
  };
}
