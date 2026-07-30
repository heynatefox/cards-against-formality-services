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

export type ReasonTag = 'meanest' | 'most_absurd' | 'most_true' | 'best_written';
export const REASON_TAGS: ReasonTag[] = ['meanest', 'most_absurd', 'most_true', 'best_written'];
