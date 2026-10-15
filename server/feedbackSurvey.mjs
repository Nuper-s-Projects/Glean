import { FEEDBACK_SENTIMENTS, FEEDBACK_IMPROVEMENTS, FEEDBACK_CONCERN_LIMIT, FEEDBACK_OTHER_LIMIT } from '../src/app/feedbackSurvey.js';

export function createFeedbackSurveyService({ database, withTransaction, requireSignedInUser, readJson, sendJson, publicAccount, isNuperAdmin }) {
  if (!database.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'feedback_survey_completed_at')) database.exec('ALTER TABLE users ADD COLUMN feedback_survey_completed_at TEXT');
  database.exec(`CREATE TABLE IF NOT EXISTS feedback_survey_responses (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sentiment TEXT NOT NULL, concern TEXT NOT NULL DEFAULT '', improvement TEXT NOT NULL,
    other TEXT NOT NULL DEFAULT '', submitted_at TEXT NOT NULL
  ) STRICT;`);
  const findResponse = database.prepare('SELECT sentiment, concern, improvement, other, submitted_at AS submittedAt FROM feedback_survey_responses WHERE user_id = ?');
  const insert = database.prepare('INSERT OR IGNORE INTO feedback_survey_responses(user_id,sentiment,concern,improvement,other,submitted_at) VALUES(?,?,?,?,?,?)');
  const complete = database.prepare('UPDATE users SET feedback_survey_completed_at = ? WHERE id = ?');
  const findUserById = database.prepare('SELECT * FROM users WHERE id = ?');
  const totals = database.prepare('SELECT COUNT(*) AS total FROM feedback_survey_responses');
  const sentiments = database.prepare('SELECT sentiment AS label, COUNT(*) AS count FROM feedback_survey_responses GROUP BY sentiment');
  const improvements = database.prepare('SELECT improvement AS label, COUNT(*) AS count FROM feedback_survey_responses GROUP BY improvement');
  const responses = database.prepare(`SELECT r.user_id AS userId, u.username, r.sentiment, r.concern, r.improvement, r.other, r.submitted_at AS submittedAt
    FROM feedback_survey_responses r JOIN users u ON u.id = r.user_id
    WHERE r.user_id < ? ORDER BY r.user_id DESC LIMIT ?`);
  const breakdown = (options, rows) => {
    const counts = new Map(rows.map(row => [row.label, row.count]));
    return options.map(label => ({ label, count: counts.get(label) || 0 }));
  };
  return async (request, response, path, method) => {
    if (!['/api/account/survey', '/api/account/survey/results'].includes(path)) return false;
    const user = requireSignedInUser(request, response);
    if (!user) return true;
    if (path.endsWith('/results')) {
      if (!isNuperAdmin?.(user)) { sendJson(response, 403, { error: 'Only Nuper can view survey results.' }); return true; }
      if (method !== 'GET') { sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET' }); return true; }
      const query = new URL(request.url, 'http://localhost').searchParams;
      const limit = Number(query.get('limit') ?? 25), before = Number(query.get('before') ?? Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(before) || before < 1) {
        sendJson(response, 400, { error: 'Invalid results page.' }); return true;
      }
      const result = (() => {
        const rows = responses.all(before, limit + 1), hasMore = rows.length > limit, page = rows.slice(0, limit);
        return { total: totals.get().total, sentiments: breakdown(FEEDBACK_SENTIMENTS, sentiments.all()),
          improvements: breakdown(FEEDBACK_IMPROVEMENTS, improvements.all()), responses: page,
          nextCursor: hasMore ? page.at(-1).userId : null };
      })();
      sendJson(response, 200, result, { 'Cache-Control': 'no-store' }); return true;
    }
    if (method === 'GET') { sendJson(response, 200, { completed: Boolean(user.feedback_survey_completed_at), response: findResponse.get(user.id) || null }); return true; }
    if (method !== 'POST') { sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' }); return true; }
    let input;
    try { input = await readJson(request, 16 * 1024); } catch (error) { sendJson(response, 400, { error: error.message || 'Invalid JSON.' }); return true; }
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['sentiment', 'concern', 'improvement', 'other'].includes(key))
      || !FEEDBACK_SENTIMENTS.includes(input.sentiment) || !FEEDBACK_IMPROVEMENTS.includes(input.improvement)
      || typeof input.concern !== 'string' || typeof input.other !== 'string'
      || input.concern.length > FEEDBACK_CONCERN_LIMIT || input.other.length > FEEDBACK_OTHER_LIMIT
      || (input.improvement === 'Other' && !input.other.trim())
      || (input.improvement !== 'Other' && input.other !== '')) {
      sendJson(response, 400, { error: 'Choose a feeling and an improvement. Concerns can be up to 2,000 characters; Other needs a description of up to 300 characters.' }); return true;
    }
    withTransaction(() => {
      const now = new Date().toISOString();
      insert.run(user.id, input.sentiment, input.concern.trim(), input.improvement, input.other.trim(), now);
      complete.run(findResponse.get(user.id).submittedAt, user.id);
    });
    sendJson(response, 200, { account: publicAccount(findUserById.get(user.id)), completed: true });
    return true;
  };
}
