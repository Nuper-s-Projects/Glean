import { REPORT_REASONS } from '../src/app/reportReasons.js';
export { REPORT_REASONS };

export function createMessageReports({ database, requireUser, readJson, sendJson, isReviewer, isProtected, channelVisible, historyStart, onRestrict, onBlock }) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS message_reports (
      id INTEGER PRIMARY KEY, reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK(source IN ('channel','dm')), message_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL, reason TEXT NOT NULL, details TEXT NOT NULL,
      evidence TEXT NOT NULL, evidence_kind TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(reporter_id,source,message_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS message_reports_reporter_time ON message_reports(reporter_id,created_at);
    CREATE INDEX IF NOT EXISTS message_reports_target ON message_reports(target_id,id);
    CREATE TABLE IF NOT EXISTS message_report_dismissals (
      report_id INTEGER PRIMARY KEY REFERENCES message_reports(id) ON DELETE CASCADE,
      reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS account_restrictions (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, until TEXT NOT NULL,
      reason TEXT NOT NULL, reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      report_id INTEGER REFERENCES message_reports(id) ON DELETE SET NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS account_restriction_audit (
      id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL, report_id INTEGER REFERENCES message_reports(id) ON DELETE SET NULL,
      until TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
  `);
  const restriction = database.prepare('SELECT until,reason FROM account_restrictions WHERE user_id=? AND until>?');
  const getRestriction = userId => restriction.get(userId, new Date().toISOString()) || null;
  const canReview = user => Boolean(user && !getRestriction(user.id) && isReviewer(user));
  const existing = database.prepare('SELECT id FROM message_reports WHERE reporter_id=? AND source=? AND message_id=?');
  const recentCount = database.prepare('SELECT COUNT(*) AS n FROM message_reports WHERE reporter_id=? AND created_at>?');
  const insert = database.prepare('INSERT INTO message_reports(reporter_id,target_id,source,message_id,location_id,reason,details,evidence,evidence_kind,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const channelMessage = database.prepare('SELECT m.*,c.server_id FROM channel_messages m JOIN server_channels c ON c.id=m.channel_id WHERE m.id=? AND m.deleted_at IS NULL');
  const directMessage = database.prepare('SELECT * FROM messages WHERE id=? AND deleted_at IS NULL');
  const membership = database.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?');
  const reportById = database.prepare('SELECT * FROM message_reports WHERE id=?');
  const dismissal = database.prepare('SELECT created_at AS dismissedAt FROM message_report_dismissals WHERE report_id=?');
  const dismiss = database.prepare('INSERT OR IGNORE INTO message_report_dismissals(report_id,reviewer_id,created_at) VALUES(?,?,?)');
  const list = database.prepare(`SELECT r.id,r.source,r.message_id AS messageId,r.location_id AS locationId,r.target_id AS targetId,
    target.username AS targetUsername,reporter.username AS reporterUsername,r.reason,r.details,r.evidence,
    r.evidence_kind AS evidenceKind,r.created_at AS createdAt,a.until AS restrictedUntil
    FROM message_reports r JOIN users target ON target.id=r.target_id JOIN users reporter ON reporter.id=r.reporter_id
    LEFT JOIN account_restrictions a ON a.user_id=r.target_id AND a.until>?
    WHERE r.id<? AND NOT EXISTS (SELECT 1 FROM message_report_dismissals d WHERE d.report_id=r.id)
    ORDER BY r.id DESC LIMIT 51`);
  const saveRestriction = database.prepare(`INSERT INTO account_restrictions(user_id,until,reason,reviewer_id,report_id,created_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET until=excluded.until,reason=excluded.reason,reviewer_id=excluded.reviewer_id,report_id=excluded.report_id,created_at=excluded.created_at`);
  const audit = database.prepare('INSERT INTO account_restriction_audit(user_id,reviewer_id,report_id,until,reason,created_at) VALUES(?,?,?,?,?,?)');
  const blocks = database.prepare('INSERT OR IGNORE INTO blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?)');
  const readInput = async request => {
    try {
      const input = await readJson(request, 32 * 1024);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid report request.');
      return input;
    } catch (error) { throw Object.assign(new Error(error.message || 'Invalid report request.'), { status: 400 }); }
  };

  async function handle(request, response, path, method) {
    if (path !== '/api/message-reports' && !/^\/api\/moderation\/reports(?:\/\d+\/(?:restrict|dismiss))?$/.test(path)) return false;
    const user = requireUser(request, response);
    if (!user) return true;
    const done = (status, payload) => { sendJson(response, status, payload); return true; };
    try {
      if (path === '/api/message-reports') {
        if (method !== 'POST') return done(405, { error: 'Use POST to report a message.' });
        const input = await readInput(request);
        if (!['channel','dm'].includes(input.source) || !Number.isSafeInteger(input.messageId) || input.messageId < 1
          || !REPORT_REASONS.includes(input.reason) || typeof input.details !== 'string' || input.details.length > 2000
          || typeof input.blockSender !== 'boolean') return done(400, { error: 'Choose a valid message and report reason.' });
        const row = input.source === 'channel' ? channelMessage.get(input.messageId) : directMessage.get(input.messageId);
        if (!row || (input.source === 'channel' ? !channelVisible(user, row.channel_id)
          : !membership.get(row.conversation_id, user.id) || row.id <= historyStart(row.conversation_id, user.id))) return done(404, { error: 'Message not found.' });
        const targetId = Number(input.source === 'channel' ? row.user_id : row.sender_id);
        if (targetId === Number(user.id)) return done(400, { error: 'You cannot report your own message.' });
        const encrypted = input.source === 'dm' && Boolean(row.ciphertext);
        if (encrypted && (input.shareMessage !== true || typeof input.messageText !== 'string' || input.messageText.length > 12000)) return done(400, { error: 'Confirm sharing this selected encrypted message with Glean moderators.' });
        const previous = existing.get(user.id, input.source, row.id);
        const now = new Date().toISOString();
        if (!previous && recentCount.get(user.id, new Date(Date.now() - 86400000).toISOString()).n >= 50) return done(429, { error: 'You can submit up to 50 reports per day.' });
        let id = previous?.id;
        database.exec('SAVEPOINT submit_message_report');
        try {
          if (!id) id = Number(insert.run(user.id,targetId,input.source,row.id,input.source === 'channel' ? row.channel_id : row.conversation_id,input.reason,input.details.trim(),encrypted ? input.messageText : String(row.body || ''),encrypted ? 'reporter-provided decrypted text' : 'server-recorded message',now).lastInsertRowid);
          if (input.blockSender) blocks.run(user.id,targetId,now);
          database.exec('RELEASE submit_message_report');
        } catch (error) { database.exec('ROLLBACK TO submit_message_report; RELEASE submit_message_report'); throw error; }
        if (input.blockSender) onBlock(user.id,targetId);
        return done(previous ? 200 : 201, { id, blocked: input.blockSender });
      }
      if (!canReview(user)) return done(403, { error: 'Only official Glean server moderators can review reports.' });
      if (path === '/api/moderation/reports' && method === 'GET') {
        const raw = new URL(request.url, 'http://localhost').searchParams.get('before');
        const before = raw === null ? Number.MAX_SAFE_INTEGER : Number(raw);
        if (!Number.isSafeInteger(before) || before < 1) return done(400, { error: 'Invalid report cursor.' });
        const rows = list.all(new Date().toISOString(), before);
        return done(200, { reports: rows.slice(0,50), nextCursor: rows.length > 50 ? rows[49].id : null });
      }
      const match = path.match(/^\/api\/moderation\/reports\/(\d+)\/(restrict|dismiss)$/);
      if (!match || method !== 'POST') return done(405, { error: 'Method not allowed.' });
      const input = await readInput(request);
      if (!canReview(user)) return done(403, { error: 'Moderator access changed. Reload and try again.' });
      const reportId = Number(match[1]);
      if (!Number.isSafeInteger(reportId) || reportId < 1) return done(400, { error: 'Invalid report ID.' });
      const report = reportById.get(reportId);
      if (!report) return done(404, { error: 'Report not found.' });
      if (match[2] === 'dismiss') {
        dismiss.run(report.id, user.id, new Date().toISOString());
        return done(200, { id: report.id, ...dismissal.get(report.id) });
      }
      if (!Number.isSafeInteger(input.durationSeconds) || input.durationSeconds < 60 || input.durationSeconds > 315360000
        || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) return done(400, { error: 'Choose a duration from one minute to ten years and provide a reason.' });
      if (dismissal.get(report.id)) return done(409, { error: 'This report has been dismissed. Refresh reports to see the active queue.' });
      if (Number(report.target_id) === Number(user.id) || isProtected(report.target_id)) return done(403, { error: 'You cannot restrict this account.' });
      const until = new Date(Math.max(Date.now() + input.durationSeconds * 1000, Date.parse(getRestriction(report.target_id)?.until || '') || 0)).toISOString();
      const values = [report.target_id,until,input.reason.trim(),user.id,report.id,new Date().toISOString()];
      database.exec('SAVEPOINT restrict_reported_account');
      try {
        saveRestriction.run(...values);
        audit.run(report.target_id,user.id,report.id,until,input.reason.trim(),values[5]);
        database.exec('RELEASE restrict_reported_account');
      } catch (error) { database.exec('ROLLBACK TO restrict_reported_account; RELEASE restrict_reported_account'); throw error; }
      onRestrict(report.target_id, { until, reason: input.reason.trim() });
      return done(200, { restrictedUntil: until });
    } catch (error) {
      if (error.status && error.status < 500) return done(error.status, { error: error.message });
      console.error('Message report request failed:', error.message);
      return done(500, { error: 'The report request could not be completed. Please try again.' });
    }
  }
  return { handle, canReview, getRestriction };
}
