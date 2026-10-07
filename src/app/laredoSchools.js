export const SCHOOL_SKIP_ID = 'no_response';

function entry(id, name, kind, district, mascot, hex, badge) {
  return { id, name, kind, district, mascot, hex, badge };
}

export const LAREDO_SCHOOLS = [
  entry('united-hs', 'United High School', 'high', 'UISD', 'Longhorns', ['#E87722', '#FFFFFF'], 'United High'),
  entry('united-hs-9', 'United 9th Grade Campus', 'high', 'UISD', 'Longhorns', ['#E87722', '#FFFFFF'], 'United High'),
  entry('alexander-hs', 'John B. Alexander High School', 'high', 'UISD', 'Bulldogs', ['#1E4B8E', '#C5B358'], 'Alexander'),
  entry('alexander-hs-9', 'Alexander 9th Grade Campus', 'high', 'UISD', 'Bulldogs', ['#1E4B8E', '#C5B358'], 'Alexander'),
  entry('lbj-hs', 'Lyndon B. Johnson High School', 'high', 'UISD', 'Wolves', ['#5B2C6F', '#111111', '#D4AF37'], 'LBJ'),
  entry('lbj-hs-9', 'LBJ 9th Grade Campus', 'high', 'UISD', 'Wolves', ['#5B2C6F', '#111111', '#D4AF37'], 'LBJ'),
  entry('united-south-hs', 'United South High School', 'high', 'UISD', 'Panthers', ['#7BAFD4', '#C0C0C0', '#111111'], 'United South'),
  entry('united-south-hs-9', 'United South 9th Grade Campus', 'high', 'UISD', 'Panthers', ['#7BAFD4', '#C0C0C0', '#111111'], 'United South'),
  entry('step-academy', 'STEP Academy', 'high', 'UISD', 'Navigators', [], 'STEP'),
  entry('martin-hs', 'Raymond & Tirza Martin High School', 'high', 'LISD', 'Tigers', ['#C8102E', '#FFFFFF'], 'Martin'),
  entry('nixon-hs', 'J.W. Nixon High School', 'high', 'LISD', 'Mustangs', ['#006747', '#D4AF37'], 'Nixon'),
  entry('cigarroa-hs', 'Dr. Leonides G. Cigarroa High School', 'high', 'LISD', 'Toros', ['#1E4D8C', '#C0C0C0'], 'Cigarroa'),
  entry('garcia-echs', 'Hector J. Garcia Early College High School', 'high', 'LISD', 'Phoenix', ['#6B1E2F', '#FFFFFF'], 'Garcia ECHS'),
  entry('vmt-magnet', 'Vidal M. Treviño Magnet', 'high', 'LISD', 'Gladiators', ['#0D7377', '#D4AF37'], 'VMT'),
  entry('lara-academy', 'F.S. Lara Academy', 'high', 'LISD', 'Rangers', ['#0A2540', '#D4AF37'], 'F.S. Lara'),
  entry('harmony-laredo', 'Harmony Science Academy – Laredo', 'other', 'Harmony', '', ['#074F9A', '#ED1C27', '#FBD800'], 'Harmony'),
  entry('united-ms', 'United Middle School', 'middle', 'UISD', 'Mavericks', ['#E87722', '#FFFFFF'], 'United Middle'),
  entry('united-ms-6', 'United 6th Grade Campus', 'middle', 'UISD', 'Mavericks', ['#E87722', '#FFFFFF'], 'United Middle'),
  entry('clark-ms', 'Clark Middle School', 'middle', 'UISD', 'Huskies', ['#1E4B8E', '#D4AF37'], 'Clark'),
  entry('lbv-ms', 'Lamar Bruni Vergara Middle School', 'middle', 'UISD', 'Jaguars', ['#6B1E2F', '#C0C0C0'], 'LBV'),
  entry('trautmann-ms', 'Trautmann Middle School', 'middle', 'UISD', 'Shorthorns', ['#E87722', '#1E4D8C'], 'Trautmann'),
  entry('los-obispos-ms', 'Los Obispos Middle School', 'middle', 'UISD', 'Wildcats', ['#1E4B8E', '#FFFFFF'], 'Los Obispos'),
  entry('washington-ms', 'George Washington Middle School', 'middle', 'UISD', 'Bobcats', ['#C8102E', '#111111'], 'Washington'),
  entry('united-south-ms', 'United South Middle School', 'middle', 'UISD', 'Leopards', ['#111111', '#9CA3AF'], 'United South Middle'),
  entry('garcia-ms', 'Salvador Garcia Middle School', 'middle', 'UISD', 'Cougars', ['#111111', '#D4AF37'], 'Salvador Garcia'),
  entry('herrera-ms', 'Elias Herrera Middle School', 'middle', 'UISD', 'Hawks', ['#E87722', '#FFFFFF'], 'Herrera'),
  entry('ramirez-ms', 'Juan R. Ramirez Middle School', 'middle', 'UISD', 'Rattlers', ['#C8102E', '#C0C0C0'], 'Ramirez'),
  entry('perales-ms', 'Raul Perales Middle School', 'middle', 'UISD', 'Oilers', ['#C8102E', '#FFFFFF', '#1E4B8E'], 'Perales'),
  entry('molina-ms', 'Ricardo Molina Middle School', 'middle', 'UISD', 'Grizzlies', ['#355E3B', '#111111'], 'Molina'),
  entry('gonzalez-ms', 'Antonio Gonzalez Middle School', 'middle', 'UISD', 'Pumas', [], 'Gonzalez'),
  entry('christen-ms', 'Louis J. Christen Middle School', 'middle', 'LISD', 'Cubs', ['#1E4D8C', '#D4AF37'], 'Christen'),
  entry('lamar-ms', 'Mirabeau B. Lamar Middle School', 'middle', 'LISD', 'Lions', ['#3D9B35', '#FFFFFF'], 'Lamar'),
  entry('memorial-ms', 'Memorial Middle School', 'middle', 'LISD', 'Eagles', ['#111111', '#C8102E', '#FFFFFF'], 'Memorial'),
  entry('cigarroa-ms', 'Dr. Joaquin G. Cigarroa Middle School', 'middle', 'LISD', 'Mighty Bulldogs', ['#C8102E', '#D4AF37'], 'Cigarroa Middle'),
];

const SCHOOL_BY_ID = new Map(LAREDO_SCHOOLS.map((item) => [item.id, item]));
const SCHOOL_IDS = new Set([...SCHOOL_BY_ID.keys(), SCHOOL_SKIP_ID]);

export function normalizeSchool(value) {
  const clean = String(value || '').trim();
  return SCHOOL_IDS.has(clean) ? clean : null;
}

export function schoolRecord(value) {
  const id = normalizeSchool(value);
  if (!id || id === SCHOOL_SKIP_ID) return null;
  return SCHOOL_BY_ID.get(id) || null;
}

export function schoolFitsGrade(schoolId, grade) {
  const id = normalizeSchool(schoolId);
  if (!id || id === SCHOOL_SKIP_ID) return true;
  const school = SCHOOL_BY_ID.get(id);
  if (!school) return false;
  const next = String(grade || '');
  if (next === 'below_hs') return school.kind === 'middle' || school.kind === 'other';
  if (next === '9' || next === '10' || next === '11' || next === '12') return school.kind === 'high' || school.kind === 'other';
  return true;
}

export function schoolsForGrade(grade) {
  const next = String(grade || '');
  return LAREDO_SCHOOLS.filter((school) => {
    if (next === 'below_hs') return school.kind === 'middle' || school.kind === 'other';
    if (next === '9' || next === '10' || next === '11' || next === '12') return school.kind === 'high' || school.kind === 'other';
    return true;
  });
}

export function searchSchools(grade, query) {
  const needle = String(query || '').trim().toLowerCase();
  const list = schoolsForGrade(grade);
  if (!needle) return list;
  return list.filter((school) => [school.name, school.mascot, school.district, school.badge].filter(Boolean).join(' ').toLowerCase().includes(needle));
}

export function schoolBadgeLabel(value) {
  const school = schoolRecord(value);
  return school ? school.badge : null;
}

export function schoolHex(value) {
  const school = schoolRecord(value);
  return school ? school.hex : null;
}

function parseHex(value) {
  const raw = String(value || '').replace('#', '');
  const hex = raw.length === 3 ? raw.split('').map((part) => part + part).join('') : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  const n = Number.parseInt(hex, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function luminance(rgb) {
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

function isLightNeutral(value) {
  const rgb = parseHex(value);
  if (!rgb) return false;
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  const sat = max === 0 ? 0 : (max - min) / max;
  return luminance(rgb) > 0.72 && sat < 0.28;
}

export function schoolBadgeStyle(hex) {
  const colors = (hex || []).filter(Boolean);
  if (!colors.length) return null;
  const fill = colors.find((color) => !isLightNeutral(color)) || colors[0];
  const rgb = parseHex(fill);
  const ink = rgb && luminance(rgb) > 0.72 ? '#1c2430' : '#ffffff';
  return { '--chip-color': fill, '--chip-ink': ink };
}
