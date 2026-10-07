export const PROGRAM_SKIP_ID = 'no_response';

function entry(id, name, hex, badge, tag) {
  return { id, name, hex, badge, tag };
}

export const PROGRAMS = [
  entry('magnet', 'MAGNET', ['#F0A202', '#FFFFFF'], 'MAGNET', 'Program'),
  entry('laredo-college', 'Laredo College', ['#1F8A4C', '#F5E6A3'], 'Laredo College', 'School'),
];

const PROGRAM_BY_ID = new Map(PROGRAMS.map((item) => [item.id, item]));
const PROGRAM_IDS = new Set([...PROGRAM_BY_ID.keys(), PROGRAM_SKIP_ID]);

export function normalizeProgram(value) {
  const clean = String(value || '').trim();
  return PROGRAM_IDS.has(clean) ? clean : null;
}

function sanitizeProgramIds(list) {
  const seen = new Set();
  for (const raw of list || []) {
    const id = normalizeProgram(raw);
    if (id) seen.add(id);
  }
  if (seen.has(PROGRAM_SKIP_ID)) return [PROGRAM_SKIP_ID];
  const ids = PROGRAMS.map((item) => item.id).filter((id) => seen.has(id));
  return ids.length ? ids : null;
}

export function parseProgramJson(value) {
  if (value == null || value === '') return null;
  if (Array.isArray(value)) return sanitizeProgramIds(value);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? sanitizeProgramIds(parsed) : null;
  } catch {
    return null;
  }
}

export function encodeProgramJson(value) {
  const list = Array.isArray(value) ? value : value != null && String(value).trim() !== '' ? [value] : [];
  const next = sanitizeProgramIds(list);
  return next ? JSON.stringify(next) : null;
}

export function publicPrograms(value) {
  const ids = parseProgramJson(value);
  if (!ids || ids.includes(PROGRAM_SKIP_ID)) return [];
  return ids.map((id) => {
    const program = PROGRAM_BY_ID.get(id);
    return program ? { id: program.id, label: program.badge, hex: program.hex } : null;
  }).filter(Boolean);
}

export function programAnswered(value) {
  return parseProgramJson(value) != null;
}

export function programDraftFromAccount(account) {
  if (!account?.programAnswered) return [];
  const ids = (account.programs || []).map((item) => item.id).filter(Boolean);
  return ids.length ? ids : [PROGRAM_SKIP_ID];
}
