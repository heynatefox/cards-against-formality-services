/**
 * Point economy, in one place.
 *
 * Round win 50, second 25, third 10, correct audience prediction 10. Second
 * and third only pay out when the czar actually ranks, which is the pressure
 * that makes ranking happen without ever gating the game on it. A reboot
 * costs a third place.
 *
 * Rooms still author their target as "rounds to win" (target: 10 reads as
 * first to 10 wins); the game converts to points at the boundary so nothing
 * about room creation or old room docs changes.
 */
export const POINTS_WIN = 50;
export const POINTS_SECOND = 25;
export const POINTS_THIRD = 10;
export const POINTS_PREDICT = 10;
export const REBOOT_COST = 10;

export const pointsTarget = (roundsTarget: number): number =>
  Math.max(1, roundsTarget || 10) * POINTS_WIN;

/**
 * Effective seconds a picking/judging phase gets. Multi-blank prompts ask
 * players to read and assemble two or three cards, and to read every rival's
 * two- or three-card play, in the same window a single blank gets. That was
 * the most common timer complaint ("not enough time on double/triple cards").
 * Add half the base round per extra blank, capped at 2.5x.
 *
 * The FRONTEND replicates this exact formula in useRoundTimer's caller; if you
 * change it here, change it there, or the on-screen clock and the server's
 * auto-advance drift apart.
 */
export const effectiveRoundSecs = (roundTime: number, turnOrPick: any): number => {
  const base = Math.max(5, roundTime || 60);
  const pick = typeof turnOrPick === 'number'
    ? turnOrPick
    : Math.max(1, (turnOrPick && turnOrPick.blackCard && turnOrPick.blackCard.pick) || 1);
  const scaled = base + Math.max(0, pick - 1) * Math.ceil(base * 0.5);
  return Math.min(scaled, Math.ceil(base * 2.5));
};

export type ReasonTag = 'meanest' | 'most_absurd' | 'most_true' | 'best_written';
export const REASON_TAGS: ReasonTag[] = ['meanest', 'most_absurd', 'most_true', 'best_written'];
