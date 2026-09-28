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
 *
 * ── Amendment: bot-judge solo (flag-gated, see pickJudgePersona below) ─────
 *
 * The above still holds for the default mode, and the no-synthetic-verdict
 * rule holds for BOTH modes. But the reasoning above got one thing wrong: it
 * optimised the round for signal quality and never asked whether the player
 * was enjoying it. In this mode the human never plays a card, and picking the
 * funny card is the entire game. Solo games end at a median of 3 rounds.
 *
 * We fixed card repetition first, on the theory that seeing the same jokes was
 * why people quit. Variety improved 20x and retention moved from 3.37 rounds
 * to 3.43, so that theory was wrong.
 *
 * The bot-judge mode inverts the round: the human gets a real hand and plays,
 * a bot judges with its taste stated up front, and the HUMAN'S PLAY is the
 * observation. The bot's verdict is never recorded as preference data, which
 * keeps the guarantee above intact (see the botJudged guard in game.ts).
 * A choice from a known hand against a named target is also strictly richer
 * than a ranking: it measures whether someone can model another person's
 * taste, not just report their own.
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

/**
 * Bot seats for solo games. A prefix check rather than a set, so the bot count
 * can change without touching every call site. Bots play, never judge, and
 * every exclusion below (czar rotation, dealing, deck maths, corpus stats)
 * keys off this one predicate.
 */
export const PROBE_BOT_PREFIX = 'probe-bot-';
export const PROBE_BOT_IDS = ['probe-bot-1', 'probe-bot-2', 'probe-bot-3'];
export const isProbeBot = (id: string): boolean =>
  typeof id === 'string' && id.indexOf(PROBE_BOT_PREFIX) === 0;

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

/** Fisher-Yates on a copy. Used to rotate the probe search window. */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
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
  exclude: Set<string> = new Set(),
): Probe | null {
  const usable = pool.filter((c) => c.tags && c.tags[axis] != null);
  if (usable.length < botCount) return null;

  // Skip what this player has seen lately, but never at the cost of returning
  // nothing: if the exclusion empties the pool, ignore it for this round.
  const fresh = usable.filter((c) => !exclude.has(c.id));
  const field = fresh.length >= botCount ? fresh : usable;

  // Authored probes for this axis first, then the rest, so the search
  // prioritises interpretable pairs without excluding the deck.
  const onAxis = (c: TaggedCard) =>
    c.tags.cls === 'probe' && (c.tags.measuresPrimary || '').startsWith(axis);

  // Cap the search: the pool is ~2,900 cards and an exhaustive pairwise pass
  // runs every round of every solo game.
  //
  // The window is filled by sampling, not by taking a fixed prefix. Slicing a
  // stably-sorted list meant the same ~240 cards were the only ones ever
  // considered, so the rest of the deck could not appear no matter how the
  // pair was chosen downstream: 2,900 cards in the pool and 186 reachable.
  // Authored probes still go in first, they are just drawn in a different
  // order each round, and the deck cards behind them rotate.
  const SEARCH_WINDOW = 240;
  const authored = shuffled(field.filter(onAxis));
  const head = authored.slice(0, SEARCH_WINDOW);
  if (head.length < SEARCH_WINDOW) {
    const rest = shuffled(field.filter((c) => !onAxis(c)));
    head.push(...rest.slice(0, SEARCH_WINDOW - head.length));
  }

  // Keep the top K pairs rather than the single argmax, then sample one.
  //
  // This used to return the highest-contrast pair outright, with no randomness
  // anywhere in the path. That made the whole function deterministic per axis:
  // the same two cards came back for every player, in every game, every time
  // that axis came up. With only a handful of axes, solo could only ever show
  // about a dozen distinct cards. Measured over 923 games: 249 distinct cards
  // total, the top 10 accounting for 83.8% of everything played, and a single
  // card served 1,087 times. Players saw the same joke by round two and left
  // (26% quit after round one, half gone by round three).
  //
  // Sampling from the top of the ranking keeps contrast high, so the round is
  // still a clean read on the axis, while making the run different per player.
  const TOP_K = 50;
  const top: { a: TaggedCard; b: TaggedCard; s: number }[] = [];
  let worstKept = -Infinity;
  for (let i = 0; i < head.length; i++) {
    for (let j = i + 1; j < head.length; j++) {
      const s = contrastScore(head[i].tags, head[j].tags, axis);
      if (top.length < TOP_K) {
        top.push({ a: head[i], b: head[j], s });
        if (top.length === TOP_K) {
          top.sort((x, y) => y.s - x.s);
          worstKept = top[TOP_K - 1].s;
        }
      } else if (s > worstKept) {
        top[TOP_K - 1] = { a: head[i], b: head[j], s };
        top.sort((x, y) => y.s - x.s);
        worstKept = top[TOP_K - 1].s;
      }
    }
  }
  if (!top.length) return null;
  top.sort((x, y) => y.s - x.s);

  // Weight by contrast so the best pairs still come up most often, shifted so
  // the weakest kept pair keeps a non-zero chance (scores can be negative).
  const floor = top[top.length - 1].s;
  const weights = top.map((p) => p.s - floor + 0.05);
  const total = weights.reduce((sum, w) => sum + w, 0);
  let r = Math.random() * total;
  let best = top[0];
  for (let i = 0; i < top.length; i++) {
    r -= weights[i];
    if (r <= 0) { best = top[i]; break; }
  }

  const cards = [best.a, best.b];
  // More than two bots: fill the remaining seats with the widest spread still
  // available on this axis, so the extra seats add range instead of noise.
  // Sampled from the widest handful for the same reason as the pair above: a
  // hard argmax here put the identical third card in every game.
  if (botCount > 2) {
    const chosen = new Set(cards.map((c) => c.id));
    const rest = field
      .filter((c) => !chosen.has(c.id))
      .sort((x, y) => Math.abs((y.tags[axis] as number) - (best.a.tags[axis] as number))
                    - Math.abs((x.tags[axis] as number) - (best.a.tags[axis] as number)));
    const needed = botCount - 2;
    const widest = rest.slice(0, Math.max(needed, Math.min(rest.length, needed * 6)));
    for (let n = 0; n < needed && widest.length; n++) {
      cards.push(widest.splice(Math.floor(Math.random() * widest.length), 1)[0]);
    }
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

// ── Bot-judge solo ("you play, a bot judges") ───────────────────────────────
//
// The original solo made the human the czar every round: three bots play, you
// pick a winner, repeat. Variety was broken and we fixed it, and retention did
// not move at all (3.37 rounds before, 3.43 after, on a 20x improvement in
// card variety). So repetition was not why people leave.
//
// The likelier reason is structural: the fun of this game is choosing the
// funny card, and the old solo gave that job to the bots and left the human
// doing admin. Half the games now invert it. You get a real hand, a bot judges
// with its taste stated up front, and your pick is the observation.
//
// That is also better data. Judging ranks two cards someone else chose;
// playing is a discrete choice from a known choice set against a named target,
// which measures whether you can model another person's taste rather than just
// your own. That is the read the data product actually sells.

export interface JudgePersona {
  axis: Axis;
  /** +1 = this judge rewards the high end of the axis, -1 = the low end. */
  direction: 1 | -1;
  /** Shown to the player, so the choice is against a known target. */
  label: string;
}

const PERSONA_LABELS: { [K in Axis]: { high: string; low: string } } = {
  heat: { high: 'goes for the meanest option', low: 'prefers to keep it gentle' },
  mode: { high: 'loves the absurd', low: 'likes it grounded and real' },
  register: { high: 'enjoys a bit of class', low: 'prefers it crude' },
  sincerity: { high: 'takes things at face value', low: 'lives on irony' },
};

/** Pick a judge persona for a round. Rotates by turn so a run varies. */
export function pickJudgePersona(turn: number, rng: () => number = Math.random): JudgePersona {
  const axis = AXES[Math.abs(turn) % AXES.length];
  const direction: 1 | -1 = rng() < 0.5 ? -1 : 1;
  return {
    axis,
    direction,
    label: direction > 0 ? PERSONA_LABELS[axis].high : PERSONA_LABELS[axis].low,
  };
}

/**
 * Judge submitted plays as the persona would.
 *
 * Scores each play by its value on the persona's axis, signed by direction.
 * Untagged cards score at the midpoint rather than losing by default, so an
 * untagged human card can still win: the alternative is a judge that only ever
 * rewards tagged cards, which would quietly bias every observation collected.
 * Ties break randomly so the same hand does not always produce the same winner.
 */
export function judgeAsPersona(
  persona: JudgePersona,
  plays: Array<{ playerId: string; tags: CardTags | null }>,
  rng: () => number = Math.random,
): string | null {
  if (!plays.length) return null;
  const scored = plays.map((p) => {
    const v = p.tags ? p.tags[persona.axis] : null;
    const base = v == null ? 0 : (v as number) * persona.direction;
    return { playerId: p.playerId, score: base + rng() * 0.01 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].playerId;
}
