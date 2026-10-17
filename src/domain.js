export const CLAIM_CATEGORIES = Object.freeze(['auto', 'property_damage', 'theft']);
export const CLAIM_STATES = Object.freeze(['submitted', 'under_review', 'approved', 'rejected']);
export const API_V1_CLAIM_LIMIT_MINOR = 1_000_000;
export const API_V2_CLAIM_LIMIT_MINOR = 500_000;

const transitions = new Map([
  ['submitted', new Set(['under_review'])],
  ['under_review', new Set(['approved', 'rejected'])],
  ['approved', new Set()],
  ['rejected', new Set()],
]);

export function canTransition(from, to) {
  return transitions.get(from)?.has(to) ?? false;
}

export function assertClaimAmount(amountMinor, limitMinor = API_V1_CLAIM_LIMIT_MINOR) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1 || amountMinor > limitMinor) {
    const error = new Error(`Claim amount must be between 1 and ${limitMinor.toLocaleString('en-US')} USD cents.`);
    error.code = 'INVALID_AMOUNT';
    error.status = 422;
    throw error;
  }
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const error = new Error(`Claim cannot move from ${from} to ${to}.`);
    error.code = 'INVALID_TRANSITION';
    error.status = 409;
    throw error;
  }
}
