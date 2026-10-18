export const TRIAL_DAYS = 14;
export const SEAT_PRICE_USD = 29;
export const MAX_SEATS_FREE = 3;

export function trialEndsAt(start: Date): Date {
  return new Date(start.getTime() + TRIAL_DAYS * 86_400_000);
}
