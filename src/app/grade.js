export const GRADE_OPTIONS = [
  { id: 'below_hs', label: 'Below High School' },
  { id: '9', label: '9th grade' },
  { id: '10', label: '10th grade' },
  { id: '11', label: '11th grade' },
  { id: '12', label: '12th grade' },
  { id: 'no_response', label: 'I wish not to respond' },
];

const GRADE_IDS = new Set(GRADE_OPTIONS.map((item) => item.id));
const GRADE_LABELS = Object.fromEntries(GRADE_OPTIONS.map((item) => [item.id, item.label]));

export function normalizeGrade(value) {
  const clean = String(value || '').trim();
  return GRADE_IDS.has(clean) ? clean : null;
}

export function gradeBadgeLabel(value) {
  const grade = normalizeGrade(value);
  if (!grade || grade === 'no_response') return null;
  return GRADE_LABELS[grade];
}
