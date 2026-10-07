export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 24;
export const USERNAME_INPUT_MAX_LENGTH = USERNAME_MAX_LENGTH * 4;
export const USERNAME_RULES_MESSAGE = 'Use 3–24 characters: letters, numbers, underscores, or Unicode symbols. No spaces.';

const allowedCharacters = /^[\p{L}\p{M}\p{N}\p{S}_]+$/u;
const forbiddenCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Z}]/u;
const visibleCharacter = /[\p{L}\p{N}\p{S}]/u;
const graphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

function graphemeLength(value) {
  return graphemeSegmenter ? [...graphemeSegmenter.segment(value)].length : Array.from(value).length;
}

export function normalizeUsername(value) {
  const username = String(value ?? '').normalize('NFC').trim();
  if (!username) return '';
  if (graphemeLength(username) < USERNAME_MIN_LENGTH || graphemeLength(username) > USERNAME_MAX_LENGTH) return '';
  if (!allowedCharacters.test(username) || forbiddenCharacters.test(username) || !visibleCharacter.test(username)) return '';
  return username;
}
