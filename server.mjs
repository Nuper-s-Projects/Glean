import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createMessageFanoutQueue } from './server/messageFanout.mjs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { gzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encodeBase32 } from './src/app/base32.js';
import { normalizeCustomBadges } from './src/app/customBadges.js';
import { normalizeUsername, USERNAME_RULES_MESSAGE } from './src/app/username.js';
import { schoolBadgeLabel, schoolFitsGrade, schoolHex, normalizeSchool } from './src/app/laredoSchools.js';
import { encodeProgramJson, parseProgramJson, programAnswered, PROGRAMS, publicPrograms } from './src/app/programs.js';
import { normalizeDiscordUsername, publicDiscordUsername } from './src/app/discordUsername.js';
import { normalizeSocialUrl, normalizeSocialUsername } from './src/app/socialLinks.js';
import { NAME_FONT_IDS } from './src/features/dm/nameFonts.js';
import { parseMultipart, sendLocalFile } from './server/files.mjs';
import { readProfileBackgroundImage } from './server/profileBackground.mjs';
import { PROFILE_BACKGROUND_URL, profileImageAdjustments } from './src/app/profileBackground.js';
import { MAIN_THEME_IMAGE_URL, normalizeMainThemes } from './src/app/mainTheme.js';
import { createMainThemeService } from './server/mainThemes.mjs';
import { createServerModelService } from './server/serverModel.mjs';
import { createServerCategories } from './server/serverCategories.mjs';
import { createGroupDmService } from './server/groupDms.mjs';
import { createFeedbackSurveyService } from './server/feedbackSurvey.mjs';
import { applySecurityHeaders, isSameOriginRequest, pruneRateLimits, requestId, takeRateLimit } from './server/security.mjs';
import { createRealtimeHub } from './server/realtime.mjs';
import { createPresenceBatch } from './server/presenceBatch.mjs';
import { createPushService } from './server/push.mjs';
import { createScheduledNotifications } from './server/scheduledNotifications.mjs';
import { createOfficialAnnouncements } from './server/officialAnnouncements.mjs';
import { createMessageReports } from './server/messageReports.mjs';
import { createNotificationPreferences } from './server/notificationPreferences.mjs';
import { applyNuraMoodDelta, buildNuraMessages, formatNuraMoodContext, NURA_IMAGE_TYPES, NURA_MAX_IMAGE_BYTES, NURA_MAX_IMAGES, requestNuraReply } from './server/nura.mjs';
import { getManagedSchoolAccessState, getSchoolAccessState } from './server/schoolSchedule.mjs';
import { createAppService } from './server/apps.mjs';
import { createLoopService } from './server/loop.mjs';
import { createVideoDownloadService } from './server/videoDownloads.mjs';
import { moderateServerMessage } from './server/moderation/index.mjs';
import { AGREEMENT_WAIT_SECONDS, CONDUCT_VERSION, TERMS_VERSION } from './src/app/agreements.js';

const rootDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const dataDirectory = process.env.GLEAN_DATA_DIR ? resolve(process.env.GLEAN_DATA_DIR) : join(rootDirectory, 'data');
const uploadDirectory = join(dataDirectory, 'uploads');
const errorReportsDirectory = join(dataDirectory, 'error-reports');
const databasePath = join(dataDirectory, 'glean-auth.sqlite');
const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 5173);
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_AVATAR_BYTES = 200 * 1024 * 1024;
const sessionLifetimeSeconds = 60 * 60 * 24 * 7;
const apiPrefix = '/api/v1';
const GIPHY_API_KEY = String(process.env.GIPHY_API_KEY || '').trim();
const GLEAN_TURN_URLS = String(process.env.GLEAN_TURN_URLS || '').split(',').map((url) => url.trim()).filter((url) => /^turns?:[a-z0-9.[\]:-]+(?::\d+)?(?:\?transport=(?:udp|tcp))?$/i.test(url));
const GLEAN_TURN_SECRET = String(process.env.GLEAN_TURN_SECRET || '').trim();
const loopRoutesEnabled = process.env.GLEAN_ENABLE_LOOP_ROUTES !== 'false';
const schoolScheduleTimeZone = String(process.env.GLEAN_SCHEDULE_TIME_ZONE || 'America/Chicago').trim();
const PLATFORM_ADMIN_NAMES = new Set(String(process.env.GLEAN_ADMIN_USERNAMES || 'Nuper').split(/[,\s]+/).map((name) => name.trim().toLowerCase()).filter(Boolean));
function randomBase32(byteLength) {
  return encodeBase32(randomBytes(byteLength));
}

mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });
mkdirSync(errorReportsDirectory, { recursive: true, mode: 0o700 });
const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true, defensive: true });
let messageReports;
database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY; PRAGMA mmap_size = 67108864; PRAGMA cache_size = -8000; PRAGMA wal_autocheckpoint = 1000;');
database.exec("CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('allow_school_hours', '0');");
const readPlatformSetting = database.prepare('SELECT value FROM platform_settings WHERE key = ?');
const writePlatformSetting = database.prepare('INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
function isSchoolHoursAllowed() { return readPlatformSetting.get('allow_school_hours')?.value === '1'; }
function currentSchoolAccess(now = new Date()) {
  return getManagedSchoolAccessState(now, schoolScheduleTimeZone, isSchoolHoursAllowed());
}

getSchoolAccessState(new Date(), schoolScheduleTimeZone);

function schoolBlockedHtml(state) {
  if (state.offlineScreen) return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Glean | Blocked</title><link rel="stylesheet" href="/blocked.css"></head><body><main class="blocked-card"><div class="blocked-mark" aria-hidden="true">G</div><h1>Blocked</h1><p class="blocked-copy">Glean is unavailable right now.</p><p class="blocked-footnote">Please check back later.</p></main></body></html>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Glean | Blocked</title><link rel="stylesheet" href="/blocked.css"><script src="/blocked-countdown.js" defer></script></head><body><main class="blocked-card" data-next-open="${state.nextOpenAt}"><div class="blocked-mark" aria-hidden="true">G</div><h1>Blocked</h1><p class="blocked-copy">Glean is unavailable during school hours. It will open in:</p><div class="countdown" role="timer" aria-live="off" aria-label="Time until Glean opens"><div class="countdown-unit"><span class="countdown-value" id="countdown-hours">--</span><span class="countdown-label">hours</span></div><div class="countdown-unit"><span class="countdown-value" id="countdown-minutes">--</span><span class="countdown-label">minutes</span></div><div class="countdown-unit"><span class="countdown-value" id="countdown-seconds">--</span><span class="countdown-label">seconds</span></div></div><p class="blocked-footnote">Glean is available outside school hours.</p></main></body></html>`;
}

function sendSchoolBlocked(response, state) {
  const retryAfter = state.nextOpenAt ? Math.max(1, Math.ceil((state.nextOpenAt - Date.now()) / 1000)) : 300;
  response.writeHead(503, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Retry-After': String(retryAfter),
  });
  response.end(schoolBlockedHtml(state));
}

function withTransaction(work) {
  database.exec('BEGIN IMMEDIATE');
  try {
    work();
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}

database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    username TEXT,
    bio TEXT NOT NULL DEFAULT '',
    private_notes_enabled INTEGER NOT NULL DEFAULT 1,
    presence_status TEXT NOT NULL DEFAULT 'auto',
    avatar_url TEXT,
    created_at TEXT NOT NULL,
    last_visited_at TEXT NOT NULL,
    agreement_prompted_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS retired_account_ids (
    id INTEGER PRIMARY KEY,
    deleted_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS user_agreement_acceptances (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    terms_version TEXT NOT NULL,
    conduct_version TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    PRIMARY KEY (user_id, terms_version, conduct_version)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS user_notes (
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, target_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS loop_posts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'none' CHECK(media_type IN ('none', 'photo', 'gif', 'video')),
    client_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, client_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS loop_posts_created_at_index ON loop_posts(created_at DESC, id DESC);
  CREATE TABLE IF NOT EXISTS loop_post_likes (
    post_id INTEGER NOT NULL REFERENCES loop_posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (post_id, user_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS loop_post_comments (
    id INTEGER PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES loop_posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS loop_post_comments_post_index ON loop_post_comments(post_id, id);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sessions_expires_at_index ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('pending', 'accepted')),
    created_at TEXT NOT NULL,
    UNIQUE(sender_id, receiver_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS friendships (
    user_one_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_two_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_one_id, user_two_id),
    CHECK (user_one_id < user_two_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind = 'direct'),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL,
    last_read_message_id INTEGER,
    PRIMARY KEY (conversation_id, user_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS message_attachments (
    id INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    storage_name TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    moderation_enabled INTEGER NOT NULL DEFAULT 0 CHECK(moderation_enabled IN (0, 1)),
    is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0, 1))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS server_roles (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#99aab5',
    permissions TEXT NOT NULL DEFAULT 'member',
    permission_flags TEXT,
    position INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE TABLE IF NOT EXISTS server_members (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES server_roles(id),
    joined_at TEXT NOT NULL,
    PRIMARY KEY (server_id, user_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS server_bans (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (server_id, user_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS server_member_devices (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_hash TEXT NOT NULL CHECK(length(device_hash) = 64),
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (server_id, user_id, device_hash)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS server_device_bans (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    device_hash TEXT NOT NULL CHECK(length(device_hash) = 64),
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (server_id, device_hash)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS server_invites (
    code TEXT PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 0 CHECK(max_uses >= 0),
    uses INTEGER NOT NULL DEFAULT 0 CHECK(uses >= 0)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS server_channels (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text' CHECK(kind = 'text'),
    position INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE TABLE IF NOT EXISTS server_bot_installs (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    bot_key TEXT NOT NULL,
    bot_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    installed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    installed_at TEXT NOT NULL,
    PRIMARY KEY (server_id, bot_key),
    UNIQUE (server_id, bot_user_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS server_bot_channels (
    server_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL REFERENCES server_channels(id) ON DELETE CASCADE,
    bot_key TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1)),
    activated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, bot_key),
    FOREIGN KEY (server_id, bot_key) REFERENCES server_bot_installs(server_id, bot_key) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE IF NOT EXISTS server_audit_log (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_name TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    target_name TEXT NOT NULL DEFAULT '',
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS channel_messages (
    id INTEGER PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES server_channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT,
    deleted_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS channel_message_reactions (
    message_id INTEGER NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL CHECK(length(emoji) BETWEEN 1 AND 16),
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS channel_message_attachments (
    id INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES server_channels(id) ON DELETE CASCADE,
    uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    storage_name TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS friend_requests_receiver_index ON friend_requests(receiver_id, status, created_at);
  CREATE INDEX IF NOT EXISTS friendships_user_one_index ON friendships(user_one_id);
  CREATE INDEX IF NOT EXISTS friendships_user_two_index ON friendships(user_two_id);
  CREATE INDEX IF NOT EXISTS conversation_members_user_index ON conversation_members(user_id, conversation_id);
  CREATE INDEX IF NOT EXISTS messages_conversation_index ON messages(conversation_id, id);
  CREATE INDEX IF NOT EXISTS channel_messages_channel_id_index ON channel_messages(channel_id, id);
  CREATE INDEX IF NOT EXISTS message_attachments_message_index ON message_attachments(message_id);
  CREATE INDEX IF NOT EXISTS server_bans_user_index ON server_bans(user_id, server_id);
  CREATE INDEX IF NOT EXISTS server_member_devices_lookup_index ON server_member_devices(server_id, device_hash, user_id);
  CREATE INDEX IF NOT EXISTS server_device_bans_server_index ON server_device_bans(server_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS server_invites_server_index ON server_invites(server_id, created_at);
  CREATE INDEX IF NOT EXISTS server_audit_log_server_index ON server_audit_log(server_id, id DESC);
  CREATE INDEX IF NOT EXISTS channel_reactions_message_index ON channel_message_reactions(message_id, emoji);
  CREATE INDEX IF NOT EXISTS channel_message_attachments_message_index ON channel_message_attachments(message_id);
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS push_subscriptions_user_index ON push_subscriptions(user_id);
  CREATE TABLE IF NOT EXISTS user_server_mutes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    muted_at TEXT NOT NULL,
    PRIMARY KEY (user_id, server_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS user_server_mutes_server_index ON user_server_mutes(server_id, user_id);
  CREATE TABLE IF NOT EXISTS user_notification_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, settings_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS user_conversation_mutes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    PRIMARY KEY(user_id,conversation_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS channel_reads (
    channel_id INTEGER NOT NULL REFERENCES server_channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS channel_message_mentions (
    message_id INTEGER NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS channel_reads_user_index ON channel_reads(user_id, channel_id);
  CREATE INDEX IF NOT EXISTS channel_message_mentions_user_index ON channel_message_mentions(user_id, message_id);
`);

const existingChannelMessageColumns = database.prepare('PRAGMA table_info(channel_messages)').all();
if (!existingChannelMessageColumns.some((column) => column.name === 'edited_at')) database.exec('ALTER TABLE channel_messages ADD COLUMN edited_at TEXT');
const existingServerChannelColumns = database.prepare('PRAGMA table_info(server_channels)').all();
if (!database.prepare('PRAGMA table_info(server_roles)').all().some((column) => column.name === 'permission_flags')) database.exec('ALTER TABLE server_roles ADD COLUMN permission_flags TEXT');
if (!existingServerChannelColumns.some((column) => column.name === 'voice')) database.exec('ALTER TABLE server_channels ADD COLUMN voice INTEGER NOT NULL DEFAULT 0');
const serverChannelColumns = database.prepare('PRAGMA table_info(server_channels)').all();
if (!serverChannelColumns.some((column) => column.name === 'channel_kind')) database.exec("ALTER TABLE server_channels ADD COLUMN channel_kind TEXT NOT NULL DEFAULT 'text'");
if (!serverChannelColumns.some((column) => column.name === 'locked')) database.exec('ALTER TABLE server_channels ADD COLUMN locked INTEGER NOT NULL DEFAULT 0');
if (!serverChannelColumns.some((column) => column.name === 'slowmode')) database.exec('ALTER TABLE server_channels ADD COLUMN slowmode INTEGER NOT NULL DEFAULT 0');
if (!serverChannelColumns.some((column) => column.name === 'topic')) database.exec("ALTER TABLE server_channels ADD COLUMN topic TEXT NOT NULL DEFAULT ''");
const serverCategories = createServerCategories({
  database, withTransaction, readJson, sendJson,
  authorize: (user, id) => Boolean(findServerById.get(id)) && canServerPermission(user, id, 'manageChannels'),
  notify: (...args) => notifyServerMembers(...args),
  audit: (...args) => writeServerAudit(...args),
});
database.exec(`
  CREATE TABLE IF NOT EXISTS server_timeouts (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    until TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (server_id, user_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS server_timeouts_until_index ON server_timeouts(until);
`);
database.exec(`
  UPDATE server_channels
  SET locked = 1,
      channel_kind = CASE
        WHEN lower(name) IN ('announcements', 'announcement') THEN 'announcement'
        WHEN lower(name) = 'rules' THEN 'rules'
        ELSE channel_kind
      END
  WHERE voice = 0 AND lower(name) IN ('announcements', 'announcement', 'rules')
`);
const existingServerColumns = database.prepare('PRAGMA table_info(servers)').all();
if (!existingServerColumns.some((column) => column.name === 'icon_url')) database.exec('ALTER TABLE servers ADD COLUMN icon_url TEXT');
if (!existingServerColumns.some((column) => column.name === 'description')) database.exec("ALTER TABLE servers ADD COLUMN description TEXT NOT NULL DEFAULT ''");
if (!existingServerColumns.some((column) => column.name === 'banner_json')) database.exec('ALTER TABLE servers ADD COLUMN banner_json TEXT');
if (!existingServerColumns.some((column) => column.name === 'moderation_enabled')) database.exec('ALTER TABLE servers ADD COLUMN moderation_enabled INTEGER NOT NULL DEFAULT 0 CHECK(moderation_enabled IN (0, 1))');
if (!existingServerColumns.some((column) => column.name === 'is_public')) database.exec('ALTER TABLE servers ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0, 1))');
database.exec('CREATE INDEX IF NOT EXISTS servers_public_index ON servers(is_public, id DESC)');
if (readPlatformSetting.get('legacy_glean_beta_server_removed')?.value !== '1') {
  withTransaction(() => {
    const legacyHubIds = database.prepare(`
      SELECT servers.id FROM servers
      JOIN users ON users.id = servers.owner_id
      WHERE lower(trim(servers.name)) = 'glean (beta)'
        AND lower(users.username) = 'nuper'
        AND trim(servers.description) LIKE 'The main hub for everything on Glean.%'
    `).all();
    const removeLegacyHub = database.prepare('DELETE FROM servers WHERE id = ?');
    for (const hub of legacyHubIds) removeLegacyHub.run(hub.id);
    writePlatformSetting.run('legacy_glean_beta_server_removed', '1');
  });
}

const existingUserColumns = database.prepare('PRAGMA table_info(users)').all();
database.exec(`
  CREATE TABLE IF NOT EXISTS user_notes (
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, target_id)
  ) STRICT;
`);
if (!existingUserColumns.some((column) => column.name === 'username')) {
  database.exec('ALTER TABLE users ADD COLUMN username TEXT');
}
if (!existingUserColumns.some((column) => column.name === 'bio')) {
  database.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
}
if (!existingUserColumns.some((column) => column.name === 'custom_badges_json')) database.exec("ALTER TABLE users ADD COLUMN custom_badges_json TEXT NOT NULL DEFAULT '[]'");
if (!existingUserColumns.some((column) => column.name === 'private_notes_enabled')) database.exec('ALTER TABLE users ADD COLUMN private_notes_enabled INTEGER NOT NULL DEFAULT 1');
if (!existingUserColumns.some((column) => column.name === 'presence_status')) database.exec("ALTER TABLE users ADD COLUMN presence_status TEXT NOT NULL DEFAULT 'auto'");
if (!existingUserColumns.some((column) => column.name === 'avatar_url')) database.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
if (!existingUserColumns.some((column) => column.name === 'public_key_jwk')) database.exec('ALTER TABLE users ADD COLUMN public_key_jwk TEXT');
if (!existingUserColumns.some((column) => column.name === 'is_bot')) database.exec('ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0 CHECK(is_bot IN (0, 1))');
if (!existingUserColumns.some((column) => column.name === 'is_verified')) database.exec('ALTER TABLE users ADD COLUMN is_verified INTEGER NOT NULL DEFAULT 0 CHECK(is_verified IN (0, 1))');
if (!existingUserColumns.some((column) => column.name === 'key_fingerprint')) database.exec('ALTER TABLE users ADD COLUMN key_fingerprint TEXT');
if (!existingUserColumns.some((column) => column.name === 'is_admin')) database.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
if (!existingUserColumns.some((column) => column.name === 'banner_json')) database.exec('ALTER TABLE users ADD COLUMN banner_json TEXT');
if (!existingUserColumns.some((column) => column.name === 'profile_background_json')) {
  database.exec('ALTER TABLE users ADD COLUMN profile_background_json TEXT');
  database.exec(`
    UPDATE users
    SET profile_background_json = banner_json,
        banner_json = NULL
    WHERE banner_json IS NOT NULL
      AND json_valid(banner_json)
      AND json_extract(banner_json, '$.kind') IN ('solid', 'gradient')
  `);
}
if (!existingUserColumns.some((column) => column.name === 'name_style_json')) database.exec('ALTER TABLE users ADD COLUMN name_style_json TEXT');
if (!existingUserColumns.some((column) => column.name === 'presence_hidden')) database.exec('ALTER TABLE users ADD COLUMN presence_hidden INTEGER NOT NULL DEFAULT 0');
if (!existingUserColumns.some((column) => column.name === 'keep_information_secret')) database.exec('ALTER TABLE users ADD COLUMN keep_information_secret INTEGER NOT NULL DEFAULT 0');
if (!existingUserColumns.some((column) => column.name === 'show_inspect_servers')) database.exec('ALTER TABLE users ADD COLUMN show_inspect_servers INTEGER NOT NULL DEFAULT 1');
if (!existingUserColumns.some((column) => column.name === 'grade')) database.exec('ALTER TABLE users ADD COLUMN grade TEXT');
if (!existingUserColumns.some((column) => column.name === 'school')) database.exec('ALTER TABLE users ADD COLUMN school TEXT');
if (existingUserColumns.some((column) => column.name === 'status_json')) database.exec('ALTER TABLE users DROP COLUMN status_json');
if (!existingUserColumns.some((column) => column.name === 'program_json')) database.exec('ALTER TABLE users ADD COLUMN program_json TEXT');
if (!existingUserColumns.some((column) => column.name === 'discord_username')) database.exec('ALTER TABLE users ADD COLUMN discord_username TEXT');
if (!existingUserColumns.some((column) => column.name === 'instagram_url')) database.exec('ALTER TABLE users ADD COLUMN instagram_url TEXT');
if (!existingUserColumns.some((column) => column.name === 'instagram_username')) database.exec('ALTER TABLE users ADD COLUMN instagram_username TEXT');
if (!existingUserColumns.some((column) => column.name === 'tiktok_url')) database.exec('ALTER TABLE users ADD COLUMN tiktok_url TEXT');
if (!existingUserColumns.some((column) => column.name === 'tiktok_username')) database.exec('ALTER TABLE users ADD COLUMN tiktok_username TEXT');
if (!existingUserColumns.some((column) => column.name === 'social_prompt_seen')) database.exec('ALTER TABLE users ADD COLUMN social_prompt_seen INTEGER NOT NULL DEFAULT 0');
if (!existingUserColumns.some((column) => column.name === 'accessibility_contrast')) database.exec('ALTER TABLE users ADD COLUMN accessibility_contrast INTEGER NOT NULL DEFAULT 100 CHECK(accessibility_contrast BETWEEN 50 AND 150)');
if (!existingUserColumns.some((column) => column.name === 'accessibility_saturation')) database.exec('ALTER TABLE users ADD COLUMN accessibility_saturation INTEGER NOT NULL DEFAULT 100 CHECK(accessibility_saturation BETWEEN 0 AND 200)');
if (!existingUserColumns.some((column) => column.name === 'accessibility_reduce_motion')) database.exec('ALTER TABLE users ADD COLUMN accessibility_reduce_motion INTEGER NOT NULL DEFAULT 0 CHECK(accessibility_reduce_motion IN (0, 1))');
if (!existingUserColumns.some((column) => column.name === 'accessibility_glass_frost')) database.exec('ALTER TABLE users ADD COLUMN accessibility_glass_frost INTEGER NOT NULL DEFAULT 50 CHECK(accessibility_glass_frost BETWEEN 0 AND 100)');
if (!existingUserColumns.some((column) => column.name === 'accessibility_glass_depth')) database.exec('ALTER TABLE users ADD COLUMN accessibility_glass_depth INTEGER NOT NULL DEFAULT 20 CHECK(accessibility_glass_depth BETWEEN 0 AND 100)');
if (!existingUserColumns.some((column) => column.name === 'accessibility_glass_refraction')) database.exec('ALTER TABLE users ADD COLUMN accessibility_glass_refraction INTEGER NOT NULL DEFAULT 100 CHECK(accessibility_glass_refraction BETWEEN 0 AND 100)');
if (!existingUserColumns.some((column) => column.name === 'accessibility_theme')) database.exec("ALTER TABLE users ADD COLUMN accessibility_theme TEXT NOT NULL DEFAULT 'system' CHECK(accessibility_theme IN ('system', 'light', 'dark'))");
if (!existingUserColumns.some((column) => column.name === 'accessibility_loop_streak_reminder')) database.exec('ALTER TABLE users ADD COLUMN accessibility_loop_streak_reminder INTEGER NOT NULL DEFAULT 1 CHECK(accessibility_loop_streak_reminder IN (0, 1))');
if (!existingUserColumns.some((column) => column.name === 'main_theme_json')) database.exec('ALTER TABLE users ADD COLUMN main_theme_json TEXT');
if (!existingUserColumns.some((column) => column.name === 'agreement_prompted_at')) database.exec('ALTER TABLE users ADD COLUMN agreement_prompted_at TEXT');
const migrateProgramFromSchool = database.prepare("SELECT id, school, program_json FROM users WHERE school IN ('magnet', 'laredo-college')");
const writeMigratedProgram = database.prepare('UPDATE users SET program_json = ?, school = NULL WHERE id = ?');
for (const row of migrateProgramFromSchool.all()) {
  const existing = parseProgramJson(row.program_json) || [];
  const next = encodeProgramJson([...existing.filter((id) => id !== 'no_response'), row.school]);
  writeMigratedProgram.run(next, row.id);
}
const existingMemberColumns = database.prepare('PRAGMA table_info(server_members)').all();
if (!existingMemberColumns.some((column) => column.name === 'sort_order')) {
  database.exec('ALTER TABLE server_members ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  const updateMemberSortOrder = database.prepare('UPDATE server_members SET sort_order = ? WHERE server_id = ? AND user_id = ?');
  const memberRows = database.prepare('SELECT user_id, server_id FROM server_members ORDER BY user_id, server_id').all();
  withTransaction(() => {
    let lastUser = null;
    let next = 0;
    for (const row of memberRows) {
      if (row.user_id !== lastUser) {
        lastUser = row.user_id;
        next = 0;
      }
      updateMemberSortOrder.run(next, row.server_id, row.user_id);
      next += 1;
    }
  });
}
database.exec(`
  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id != blocked_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS blocks_blocked_index ON blocks(blocked_id);
  CREATE TABLE IF NOT EXISTS conversation_pins (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, conversation_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS conversation_pins_conversation_index ON conversation_pins(conversation_id);
`);
if (!existingChannelMessageColumns.some((column) => column.name === 'reply_to_message_id')) database.exec('ALTER TABLE channel_messages ADD COLUMN reply_to_message_id INTEGER');
if (!existingChannelMessageColumns.some((column) => column.name === 'poll_json')) database.exec('ALTER TABLE channel_messages ADD COLUMN poll_json TEXT');
database.exec(`
  CREATE TABLE IF NOT EXISTS channel_poll_votes (
    message_id INTEGER NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    option_index INTEGER NOT NULL CHECK(option_index >= 0 AND option_index <= 9),
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, option_index)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS channel_poll_votes_message_index ON channel_poll_votes(message_id);
  CREATE INDEX IF NOT EXISTS channel_poll_votes_option_index ON channel_poll_votes(message_id, option_index, user_id);
`);
database.exec('CREATE INDEX IF NOT EXISTS channel_messages_channel_id_index ON channel_messages(channel_id, id)');
database.exec('CREATE INDEX IF NOT EXISTS channel_messages_live_count_index ON channel_messages(channel_id, id) WHERE deleted_at IS NULL');
database.exec('CREATE INDEX IF NOT EXISTS channel_messages_live_author_index ON channel_messages(channel_id, user_id, id) WHERE deleted_at IS NULL');
database.exec(`CREATE TABLE IF NOT EXISTS e2ee_sync_vaults (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  envelope TEXT NOT NULL,
  active_public_key TEXT NOT NULL
) STRICT`);
database.exec(`CREATE TABLE IF NOT EXISTS e2ee_key_history (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT,
  public_key TEXT,
  envelope TEXT,
  archived_at TEXT NOT NULL
) STRICT; CREATE INDEX IF NOT EXISTS e2ee_key_history_user_index ON e2ee_key_history(user_id, id)`);
database.exec(`CREATE TABLE IF NOT EXISTS e2ee_profile_key_backups (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  backup TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT`);
const readSyncVault = database.prepare('SELECT revision, envelope, active_public_key FROM e2ee_sync_vaults WHERE user_id = ?');
const createSyncVault = database.prepare('INSERT OR IGNORE INTO e2ee_sync_vaults VALUES (?, 1, ?, ?)');
const replaceSyncVault = database.prepare('UPDATE e2ee_sync_vaults SET revision = revision + 1, envelope = ?, active_public_key = ? WHERE user_id = ? AND revision = ?');
const archiveSyncVault = database.prepare('INSERT INTO e2ee_key_history (user_id, fingerprint, public_key, envelope, archived_at) VALUES (?, ?, ?, ?, ?)');
const readProfileKeyBackup = database.prepare('SELECT revision, backup FROM e2ee_profile_key_backups WHERE user_id = ?');
const createProfileKeyBackup = database.prepare('INSERT OR IGNORE INTO e2ee_profile_key_backups (user_id, revision, backup, updated_at) VALUES (?, 1, ?, ?)');
const replaceProfileKeyBackup = database.prepare('UPDATE e2ee_profile_key_backups SET revision = revision + 1, backup = ?, updated_at = ? WHERE user_id = ? AND revision = ?');
database.exec('CREATE INDEX IF NOT EXISTS server_members_user_sort_index ON server_members(user_id, sort_order, server_id)');
database.exec('CREATE INDEX IF NOT EXISTS channel_message_mentions_message_index ON channel_message_mentions(message_id)');
database.exec('CREATE INDEX IF NOT EXISTS channel_messages_live_id_index ON channel_messages(channel_id, id) WHERE deleted_at IS NULL');
database.exec('CREATE INDEX IF NOT EXISTS channel_messages_live_unread_index ON channel_messages(channel_id, user_id, id) WHERE deleted_at IS NULL');
database.exec(`CREATE TABLE IF NOT EXISTS channel_message_cleanup_schedules (
  channel_id INTEGER PRIMARY KEY REFERENCES server_channels(id) ON DELETE CASCADE,
  interval_seconds INTEGER NOT NULL CHECK(interval_seconds IN (1800, 3600, 21600, 43200, 86400, 604800)),
  next_run_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
) STRICT; CREATE INDEX IF NOT EXISTS channel_message_cleanup_due_index ON channel_message_cleanup_schedules(next_run_at)`);

function migrateNullableUserAttribution(table, createSql, copySql, indexesSql) {
  const creator = database.prepare(`PRAGMA table_info(${table})`).all().find((column) => ['created_by', 'updated_by'].includes(column.name));
  if (!creator?.notnull) return;
  database.exec('PRAGMA foreign_keys = OFF');
  try {
    database.exec('BEGIN IMMEDIATE');
    database.exec(createSql);
    database.exec(copySql);
    database.exec(`DROP TABLE ${table}`);
    database.exec(`ALTER TABLE ${table}_replacement RENAME TO ${table}`);
    database.exec('COMMIT');
    database.exec(indexesSql);
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}

migrateNullableUserAttribution(
  'server_bans',
  `CREATE TABLE server_bans_replacement (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (server_id, user_id)
  ) STRICT`,
  'INSERT INTO server_bans_replacement SELECT server_id, user_id, reason, created_at, created_by FROM server_bans',
  'CREATE INDEX IF NOT EXISTS server_bans_server_index ON server_bans(server_id)'
);
migrateNullableUserAttribution(
  'server_timeouts',
  `CREATE TABLE server_timeouts_replacement (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    until TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (server_id, user_id)
  ) STRICT`,
  'INSERT INTO server_timeouts_replacement SELECT server_id, user_id, until, reason, created_by, created_at FROM server_timeouts',
  'CREATE INDEX IF NOT EXISTS server_timeouts_until_index ON server_timeouts(until)'
);
migrateNullableUserAttribution(
  'channel_message_cleanup_schedules',
  `CREATE TABLE channel_message_cleanup_schedules_replacement (
    channel_id INTEGER PRIMARY KEY REFERENCES server_channels(id) ON DELETE CASCADE,
    interval_seconds INTEGER NOT NULL CHECK(interval_seconds IN (1800, 3600, 21600, 43200, 86400, 604800)),
    next_run_at TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  'INSERT INTO channel_message_cleanup_schedules_replacement SELECT channel_id, interval_seconds, next_run_at, updated_by, updated_at FROM channel_message_cleanup_schedules',
  'CREATE INDEX IF NOT EXISTS channel_message_cleanup_due_index ON channel_message_cleanup_schedules(next_run_at)'
);
const existingMessageColumnsForSocial = database.prepare('PRAGMA table_info(messages)').all();
for (const [name, definition] of [
  ['edited_at', 'TEXT'], ['deleted_at', 'TEXT'], ['reply_to_message_id', 'INTEGER'],
]) if (!existingMessageColumnsForSocial.some((column) => column.name === name)) database.exec(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`);
for (const name of PLATFORM_ADMIN_NAMES) database.prepare('UPDATE users SET is_admin = 1 WHERE username IS NOT NULL AND lower(username) = ?').run(name);
database.exec('DROP INDEX IF EXISTS users_username_index; CREATE UNIQUE INDEX users_username_index ON users(username COLLATE NOCASE) WHERE username IS NOT NULL');

const existingSessionColumns = database.prepare('PRAGMA table_info(sessions)').all();
for (const [name, definition] of [
  ['created_at', 'TEXT'], ['last_seen_at', 'TEXT'], ['user_agent', 'TEXT'], ['ip', 'TEXT'], ['public_id', 'TEXT'],
]) if (!existingSessionColumns.some((column) => column.name === name)) database.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
database.exec('CREATE UNIQUE INDEX IF NOT EXISTS sessions_public_id_index ON sessions(public_id) WHERE public_id IS NOT NULL');
// Keep session management functional without retaining activity fingerprints.
database.exec("UPDATE sessions SET last_seen_at = NULL, user_agent = NULL, ip = NULL WHERE last_seen_at IS NOT NULL OR user_agent IS NOT NULL OR ip IS NOT NULL");
database.exec("UPDATE users SET last_visited_at = created_at WHERE last_visited_at IS NOT created_at");

const existingMessageColumns = database.prepare('PRAGMA table_info(messages)').all();
for (const [name, definition] of [
  ['ciphertext', 'TEXT'], ['iv', 'TEXT'], ['salt', 'TEXT'], ['sender_public_key', 'TEXT'], ['recipient_public_key', 'TEXT'],
  ['client_message_id', 'TEXT'], ['encryption_version', 'INTEGER NOT NULL DEFAULT 0'], ['group_keys_json', 'TEXT']
]) if (!existingMessageColumns.some((column) => column.name === name)) database.exec(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`);
database.exec('CREATE UNIQUE INDEX IF NOT EXISTS messages_client_message_id_index ON messages(conversation_id, sender_id, client_message_id) WHERE client_message_id IS NOT NULL');
database.exec('CREATE INDEX IF NOT EXISTS messages_live_conversation_id_index ON messages(conversation_id, id) WHERE deleted_at IS NULL');
database.exec('CREATE INDEX IF NOT EXISTS messages_live_unread_index ON messages(conversation_id, sender_id, id) WHERE deleted_at IS NULL');
// Keep join/read boundaries valid when account deletion removes the highest row ID.
database.exec(`
  CREATE TABLE IF NOT EXISTS dm_message_sequence (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), last_id INTEGER NOT NULL) STRICT;
  INSERT OR IGNORE INTO dm_message_sequence VALUES(1, (SELECT COALESCE(MAX(id), 0) FROM messages));
  UPDATE dm_message_sequence SET last_id = MAX(last_id, (SELECT COALESCE(MAX(id), 0) FROM messages)) WHERE singleton = 1;
  CREATE TRIGGER IF NOT EXISTS dm_message_sequence_insert AFTER INSERT ON messages BEGIN
    UPDATE dm_message_sequence SET last_id = MAX(last_id, NEW.id) WHERE singleton = 1;
  END;
`);

const groupDms = createGroupDmService({ database, areFriends, isBlockedEither, publicPresence, publicNameStyle, publicCustomBadges, sendEvent,
  directMessagePayload: row => directMessagePayload(loadDirectMessageRow.get(row.id)), publicKeyMatchesStored, removeStoredUploads });
const handleFeedbackSurvey = createFeedbackSurveyService({ database, withTransaction, requireSignedInUser, readJson, sendJson, publicAccount, isNuperAdmin });
database.exec('DROP TABLE IF EXISTS outcome_memory_ribbons');

const existingAttachmentColumns = database.prepare('PRAGMA table_info(message_attachments)').all();
for (const [name, definition] of [
  ['encrypted', 'INTEGER NOT NULL DEFAULT 0'], ['iv', 'TEXT'], ['salt', 'TEXT'], ['sender_public_key', 'TEXT'], ['recipient_public_key', 'TEXT']
]) if (!existingAttachmentColumns.some((column) => column.name === name)) database.exec(`ALTER TABLE message_attachments ADD COLUMN ${name} ${definition}`);

database.exec(`
  UPDATE conversation_members
  SET last_read_message_id = COALESCE((
    SELECT MAX(id) FROM messages WHERE conversation_id = conversation_members.conversation_id
  ), 0)
  WHERE last_read_message_id IS NULL;
  INSERT OR IGNORE INTO channel_reads (channel_id, user_id, last_read_message_id)
  SELECT server_channels.id, server_members.user_id, COALESCE((
    SELECT MAX(id) FROM channel_messages WHERE channel_id = server_channels.id AND deleted_at IS NULL
  ), 0)
  FROM server_members
  JOIN server_channels ON server_channels.server_id = server_members.server_id
  WHERE server_channels.voice = 0;
`);

const nextAccountId = database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM (SELECT id FROM users UNION ALL SELECT id FROM retired_account_ids)');
const insertUser = database.prepare('INSERT INTO users (id, email, password_hash, password_salt, username, created_at, last_visited_at, grade, school) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const findUserByEmail = database.prepare('SELECT * FROM users WHERE email = ?');
const findUserById = database.prepare('SELECT * FROM users WHERE id = ?');
const findKeepInformationSecret = database.prepare('SELECT keep_information_secret FROM users WHERE id = ?');
const findUserByUsername = database.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE');
const findNuraAccount = database.prepare('SELECT id, email, is_bot FROM users WHERE username = ? COLLATE NOCASE');
const findUserBySession = database.prepare(`
  SELECT users.feedback_survey_completed_at,
  users.main_theme_json, users.id, users.email, users.username, users.bio, users.custom_badges_json, users.private_notes_enabled, users.presence_status, users.avatar_url, users.banner_json, users.profile_background_json, users.name_style_json, users.public_key_jwk, users.key_fingerprint, users.is_verified, users.created_at, users.last_visited_at, users.presence_hidden, users.keep_information_secret, users.show_inspect_servers, users.grade, users.school, users.program_json, users.discord_username, users.instagram_url, users.instagram_username, users.tiktok_url, users.tiktok_username, users.social_prompt_seen, users.accessibility_contrast, users.accessibility_saturation, users.accessibility_reduce_motion, users.accessibility_glass_frost, users.accessibility_glass_depth, users.accessibility_glass_refraction, users.accessibility_theme, users.accessibility_loop_streak_reminder, users.agreement_prompted_at
  FROM sessions JOIN users ON users.id = sessions.user_id
  WHERE sessions.token_hash = ? AND sessions.expires_at > ?
`);
const findAgreementAcceptance = database.prepare('SELECT accepted_at FROM user_agreement_acceptances WHERE user_id = ? AND terms_version = ? AND conduct_version = ?');
const recordAgreementAcceptance = database.prepare('INSERT OR IGNORE INTO user_agreement_acceptances (user_id, terms_version, conduct_version, accepted_at) VALUES (?, ?, ?, ?)');
const updateAgreementPromptedAt = database.prepare('UPDATE users SET agreement_prompted_at = ? WHERE id = ?');
const updateUsername = database.prepare('UPDATE users SET username = ? WHERE id = ?');
const updateBio = database.prepare('UPDATE users SET bio = ? WHERE id = ?');
const updateCustomBadges = database.prepare('UPDATE users SET custom_badges_json = ? WHERE id = ?');
const updateBanner = database.prepare('UPDATE users SET banner_json = ? WHERE id = ?');
const updateProfileBackground = database.prepare('UPDATE users SET profile_background_json = ? WHERE id = ?');
const updateNameStyle = database.prepare('UPDATE users SET name_style_json = ? WHERE id = ?');
const updatePassword = database.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?');
const updatePresenceHidden = database.prepare('UPDATE users SET presence_hidden = ? WHERE id = ?');
const updateKeepInformationSecret = database.prepare('UPDATE users SET keep_information_secret = ? WHERE id = ?');
const updateShowInspectServers = database.prepare('UPDATE users SET show_inspect_servers = ? WHERE id = ?');
const updateGrade = database.prepare('UPDATE users SET grade = ? WHERE id = ?');
const updateSchool = database.prepare('UPDATE users SET school = ? WHERE id = ?');
const updateProgram = database.prepare('UPDATE users SET program_json = ? WHERE id = ?');
const updateDiscordUsername = database.prepare('UPDATE users SET discord_username = ? WHERE id = ?');
const updateSocialLinks = database.prepare('UPDATE users SET instagram_url = ?, instagram_username = ?, tiktok_url = ?, tiktok_username = ? WHERE id = ?');
const markSocialPromptSeen = database.prepare('UPDATE users SET social_prompt_seen = 1 WHERE id = ?');
const updateAccessibilitySettings = database.prepare('UPDATE users SET accessibility_contrast = ?, accessibility_saturation = ?, accessibility_reduce_motion = ?, accessibility_glass_frost = ?, accessibility_glass_depth = ?, accessibility_glass_refraction = ?, accessibility_theme = ?, accessibility_loop_streak_reminder = ? WHERE id = ?');
const updatePrivateNotesEnabled = database.prepare('UPDATE users SET private_notes_enabled = ? WHERE id = ?');
const updatePresenceStatus = database.prepare('UPDATE users SET presence_status = ? WHERE id = ?');
const getUserNote = database.prepare('SELECT note FROM user_notes WHERE owner_id = ? AND target_id = ?');
const saveUserNote = database.prepare(`
  INSERT INTO user_notes (owner_id, target_id, note, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(owner_id, target_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at
`);
const insertSession = database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at, user_agent, ip, public_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const deleteSession = database.prepare('DELETE FROM sessions WHERE token_hash = ?');
const deleteExpiredSessions = database.prepare('DELETE FROM sessions WHERE expires_at <= ?');
const listUserSessions = database.prepare('SELECT public_id, token_hash, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC');
const updateSessionPublicId = database.prepare('UPDATE sessions SET public_id = ? WHERE token_hash = ? AND (public_id IS NULL OR public_id = \'\')');
const deleteSessionByPublicId = database.prepare('DELETE FROM sessions WHERE public_id = ? AND user_id = ?');
const deleteOtherSessions = database.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?');
const deleteAllUserSessions = database.prepare('DELETE FROM sessions WHERE user_id = ?');
const findSessionTokenByPublicId = database.prepare('SELECT token_hash FROM sessions WHERE public_id = ? AND user_id = ?');
for (const row of database.prepare("SELECT token_hash FROM sessions WHERE public_id IS NULL OR public_id = ''").all()) {
  updateSessionPublicId.run(randomBase32(12), row.token_hash);
}
const findPublicUserByUsername = database.prepare('SELECT id, username, public_key_jwk, key_fingerprint, is_bot FROM users WHERE username = ? COLLATE NOCASE');
const updateUserPublicKey = database.prepare('UPDATE users SET public_key_jwk = ?, key_fingerprint = ? WHERE id = ?');
const findFriendship = database.prepare('SELECT 1 FROM friendships WHERE user_one_id = ? AND user_two_id = ?');
const deleteFriendship = database.prepare('DELETE FROM friendships WHERE user_one_id = ? AND user_two_id = ?');
const deletePairFriendRequests = database.prepare('DELETE FROM friend_requests WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)');
const findBlock = database.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?');
const insertBlock = database.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)');
const deleteBlock = database.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?');
const listBlockedUsers = database.prepare(`
  SELECT users.id, users.username, users.avatar_url
  FROM blocks JOIN users ON users.id = blocks.blocked_id
  WHERE blocks.blocker_id = ?
  ORDER BY users.username COLLATE NOCASE
`);
const insertFriendRequest = database.prepare('INSERT INTO friend_requests (sender_id, receiver_id, status, created_at) VALUES (?, ?, \'pending\', ?)');
const findExistingRequest = database.prepare(`
  SELECT id, sender_id, receiver_id, status FROM friend_requests
  WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
`);
const findIncomingRequest = database.prepare('SELECT id, sender_id FROM friend_requests WHERE id = ? AND receiver_id = ? AND status = \'pending\'');
const updateFriendRequestAccepted = database.prepare('UPDATE friend_requests SET status = \'accepted\' WHERE id = ?');
const insertFriendship = database.prepare('INSERT OR IGNORE INTO friendships (user_one_id, user_two_id, created_at) VALUES (?, ?, ?)');
const setUserAsBot = database.prepare("UPDATE users SET is_bot = 1, bio = 'hi! im nura, you can chat with me through dms!', presence_status = 'online', public_key_jwk = NULL, key_fingerprint = NULL WHERE id = ?");
const nuraAccount = findNuraAccount.get('Nura');
if (nuraAccount && (Number(nuraAccount.is_bot) !== 1 || nuraAccount.email !== 'nura@bot.glean.internal')) {
  throw new Error('Cannot create the Nura bot because the username Nura is already used by a regular Glean account.');
}
if (!nuraAccount) {
  const createdAt = new Date().toISOString();
  const id = Number(nextAccountId.get().id);
  const salt = randomBytes(32).toString('base64url');
  const unreachablePasswordHash = scryptSync(randomBytes(64), salt, 64).toString('base64url');
  insertUser.run(id, 'nura@bot.glean.internal', unreachablePasswordHash, salt, 'Nura', createdAt, createdAt, null, null);
  setUserAsBot.run(id);
}
const findNuraId = database.prepare("SELECT id FROM users WHERE username = 'Nura' COLLATE NOCASE AND is_bot = 1");
const NURA_USER_ID = Number(findNuraId.get().id);
database.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run('/nura-avatar.png', NURA_USER_ID);
database.prepare('UPDATE users SET bio = ? WHERE id = ?').run('hi! im nura, you can chat with me through dms!', NURA_USER_ID);
database.exec(`
  CREATE TABLE IF NOT EXISTS nura_mood_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    energy REAL NOT NULL DEFAULT 5,
    patience REAL NOT NULL DEFAULT 5,
    happiness REAL NOT NULL DEFAULT 5,
    stress REAL NOT NULL DEFAULT 3,
    updated_at TEXT NOT NULL
  ) STRICT;
  INSERT OR IGNORE INTO nura_mood_state (id, updated_at) VALUES (1, '${new Date().toISOString()}');
  CREATE TABLE IF NOT EXISTS nura_user_bonds (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    trust REAL NOT NULL DEFAULT 5,
    affection REAL NOT NULL DEFAULT 5,
    annoyance REAL NOT NULL DEFAULT 0,
    last_event TEXT,
    updated_at TEXT NOT NULL
  ) STRICT;
`);
const readNuraMood = database.prepare('SELECT energy, patience, happiness, stress FROM nura_mood_state WHERE id = 1');
const readNuraBond = database.prepare('SELECT trust, affection, annoyance, last_event FROM nura_user_bonds WHERE user_id = ?');
const writeNuraMood = database.prepare('UPDATE nura_mood_state SET energy = ?, patience = ?, happiness = ?, stress = ?, updated_at = ? WHERE id = 1');
const writeNuraBond = database.prepare(`
  INSERT INTO nura_user_bonds (user_id, trust, affection, annoyance, last_event, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET trust = excluded.trust, affection = excluded.affection,
    annoyance = excluded.annoyance, last_event = COALESCE(excluded.last_event, nura_user_bonds.last_event), updated_at = excluded.updated_at
`);
const listNuraHistory = database.prepare(`
  SELECT messages.body, messages.sender_id
  FROM messages
  WHERE messages.conversation_id = ? AND messages.deleted_at IS NULL AND messages.encryption_version = 0
  ORDER BY messages.id DESC LIMIT 30
`);
const listFriends = database.prepare(`
  SELECT users.id, users.username, users.avatar_url, users.name_style_json, users.is_bot, users.is_verified
  FROM friendships
  JOIN users ON users.id = CASE WHEN friendships.user_one_id = ? THEN friendships.user_two_id ELSE friendships.user_one_id END
  WHERE friendships.user_one_id = ? OR friendships.user_two_id = ?
  ORDER BY users.username COLLATE NOCASE
`);
const listIncomingRequests = database.prepare(`
  SELECT friend_requests.id, users.id AS user_id, users.username, users.avatar_url, users.name_style_json, users.is_verified, friend_requests.created_at
  FROM friend_requests JOIN users ON users.id = friend_requests.sender_id
  WHERE friend_requests.receiver_id = ? AND friend_requests.status = 'pending'
  ORDER BY friend_requests.created_at DESC
`);
const listOutgoingRequests = database.prepare(`
  SELECT friend_requests.id, users.id AS user_id, users.username, users.avatar_url, users.name_style_json, users.is_verified, friend_requests.created_at
  FROM friend_requests JOIN users ON users.id = friend_requests.receiver_id
  WHERE friend_requests.sender_id = ? AND friend_requests.status = 'pending'
  ORDER BY friend_requests.created_at DESC
`);
const deleteOutgoingRequest = database.prepare(`DELETE FROM friend_requests WHERE id = ? AND sender_id = ? AND status = 'pending'`);
const deleteIncomingRequest = database.prepare(`DELETE FROM friend_requests WHERE id = ? AND receiver_id = ? AND status = 'pending'`);
const findOutgoingRequest = database.prepare(`SELECT id, receiver_id FROM friend_requests WHERE id = ? AND sender_id = ? AND status = 'pending'`);
const listUserCensus = database.prepare('SELECT grade, school, program_json, created_at FROM users WHERE username IS NOT NULL AND is_bot = 0');
const listAnalyticsPeople = database.prepare(`
  SELECT id, username, avatar_url, grade, school, program_json, created_at, is_verified
  FROM users
  WHERE username IS NOT NULL AND is_bot = 0 AND id > ? AND instr(lower(username), lower(?)) > 0
  ORDER BY id ASC
  LIMIT ?
`);
const discoverPeopleSql = `
  WITH params AS (SELECT ? AS viewer_id, ? AS query, ? AS school, ? AS program, ? AS grade, ? AS relation_filter, ? AS attributes),
  directory AS (
  SELECT users.id, users.username, users.avatar_url, users.bio, users.grade, users.school, users.program_json, users.custom_badges_json, users.is_verified,
    CASE
      WHEN friend.user_one_id IS NOT NULL THEN 'friend'
      WHEN outgoing.id IS NOT NULL THEN 'outgoing'
      WHEN incoming.id IS NOT NULL THEN 'incoming'
      ELSE 'none'
    END AS relation,
    COALESCE(outgoing.id, incoming.id) AS request_id,
    (users.school = 'vmt-magnet' OR EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(users.program_json) THEN users.program_json ELSE '[]' END) WHERE value = 'magnet'
    )) AS magnet,
    EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(users.program_json) THEN users.program_json ELSE '[]' END) WHERE value = 'laredo-college'
    ) AS laredo_college
  FROM users CROSS JOIN params
  LEFT JOIN friendships friend
    ON (friend.user_one_id = params.viewer_id AND friend.user_two_id = users.id)
    OR (friend.user_two_id = params.viewer_id AND friend.user_one_id = users.id)
  LEFT JOIN friend_requests outgoing
    ON outgoing.sender_id = params.viewer_id AND outgoing.receiver_id = users.id AND outgoing.status = 'pending'
  LEFT JOIN friend_requests incoming
    ON incoming.receiver_id = params.viewer_id AND incoming.sender_id = users.id AND incoming.status = 'pending'
  LEFT JOIN blocks blocked
    ON blocked.blocker_id = params.viewer_id AND blocked.blocked_id = users.id
  WHERE users.username IS NOT NULL AND users.is_bot = 0 AND users.id != params.viewer_id AND blocked.blocker_id IS NULL
    AND (params.query = '' OR instr(lower(users.username), lower(params.query)) > 0 OR instr(lower(COALESCE(users.bio, '')), lower(params.query)) > 0)
    AND (params.school = '' OR users.school = params.school)
    AND (params.program = '' OR EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(users.program_json) THEN users.program_json ELSE '[]' END) AS selected_program
      WHERE selected_program.value = params.program
    ))
    AND (params.grade = '' OR users.grade = params.grade)
  ), matches AS (
    SELECT directory.* FROM directory CROSS JOIN params
    WHERE (params.relation_filter = 'all'
      OR (params.relation_filter = 'add' AND relation = 'none')
      OR (params.relation_filter = 'friends' AND relation = 'friend')
      OR (params.relation_filter = 'pending' AND relation IN ('incoming', 'outgoing')))
    AND (params.attributes = ''
      OR (instr(',' || params.attributes || ',', ',magnet,') > 0 AND magnet)
      OR (instr(',' || params.attributes || ',', ',laredo-college,') > 0 AND laredo_college))
  )
`;
const listDiscoverPeople = database.prepare(`${discoverPeopleSql} SELECT * FROM matches WHERE id > ? ORDER BY id ASC LIMIT ?`);
const countDiscoverPeople = database.prepare(`${discoverPeopleSql}
  SELECT COUNT(*) AS total, SUM(relation = 'none') AS to_add, SUM(relation = 'friend') AS friends,
    SUM(relation IN ('incoming', 'outgoing')) AS pending, SUM(magnet) AS magnet, SUM(laredo_college) AS laredo_college,
    (SELECT COUNT(*) FROM matches) AS matched_total FROM directory
`);
const findProfileByUsername = database.prepare(`
  SELECT users.id, users.username, users.avatar_url, users.banner_json, users.profile_background_json, users.name_style_json, users.bio, users.created_at, users.is_admin, users.is_verified, users.grade, users.school, users.program_json, users.custom_badges_json, users.discord_username, users.instagram_url, users.instagram_username, users.tiktok_url, users.tiktok_username,
    CASE
      WHEN users.id = ? THEN 'self'
      WHEN blocked.blocker_id IS NOT NULL THEN 'blocked'
      WHEN friend.user_one_id IS NOT NULL THEN 'friend'
      WHEN outgoing.id IS NOT NULL THEN 'outgoing'
      WHEN incoming.id IS NOT NULL THEN 'incoming'
      ELSE 'none'
    END AS relation,
    COALESCE(outgoing.id, incoming.id) AS request_id
  FROM users
  LEFT JOIN blocks blocked
    ON blocked.blocker_id = ? AND blocked.blocked_id = users.id
  LEFT JOIN friendships friend
    ON (friend.user_one_id = ? AND friend.user_two_id = users.id)
    OR (friend.user_two_id = ? AND friend.user_one_id = users.id)
  LEFT JOIN friend_requests outgoing
    ON outgoing.sender_id = ? AND outgoing.receiver_id = users.id AND outgoing.status = 'pending'
  LEFT JOIN friend_requests incoming
    ON incoming.receiver_id = ? AND incoming.sender_id = users.id AND incoming.status = 'pending'
  WHERE users.username = ? COLLATE NOCASE AND users.username IS NOT NULL
`);
const findDirectConversation = database.prepare(`
  SELECT conversations.id
  FROM conversations
  JOIN conversation_members first_member ON first_member.conversation_id = conversations.id AND first_member.user_id = ?
  JOIN conversation_members second_member ON second_member.conversation_id = conversations.id AND second_member.user_id = ?
  WHERE conversations.kind = 'direct'
    AND NOT EXISTS (SELECT 1 FROM group_conversations g WHERE g.conversation_id = conversations.id)
    AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = conversations.id) = 2
  LIMIT 1
`);
const insertConversation = database.prepare('INSERT INTO conversations (kind, created_at) VALUES (\'direct\', ?)');
const insertConversationMember = database.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)');
const isConversationMember = database.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?');
const listConversationPeerIdsForUser = database.prepare(`
  SELECT DISTINCT other_member.user_id
  FROM conversation_members my_member
  JOIN conversation_members other_member ON other_member.conversation_id = my_member.conversation_id
  WHERE my_member.user_id = ? AND other_member.user_id != ?
`);
const findConversationPeer = database.prepare(`
  SELECT users.id, users.username, users.avatar_url, users.public_key_jwk, users.key_fingerprint, users.custom_badges_json, users.is_bot, users.is_verified
  FROM conversation_members JOIN users ON users.id = conversation_members.user_id
  WHERE conversation_members.conversation_id = ? AND users.id != ? LIMIT 1
`);
const listConversations = database.prepare(`
  SELECT conversations.id, other_user.id AS user_id, other_user.username, other_user.bio, other_user.avatar_url,
    other_user.public_key_jwk, other_user.key_fingerprint, other_user.name_style_json, other_user.custom_badges_json, other_user.is_bot, other_user.is_verified,
    last_message.body AS last_message_body, last_message.ciphertext AS last_message_ciphertext, last_message.created_at AS last_message_at,
    last_message.id AS preview_id, last_message.sender_id AS preview_sender_id,
    last_message.iv AS preview_iv, last_message.salt AS preview_salt,
    last_message.sender_public_key AS preview_sender_key, last_message.recipient_public_key AS preview_recipient_key,
    last_message.client_message_id AS preview_client_id,
    (
      SELECT COUNT(*) FROM messages unread
      WHERE unread.conversation_id = conversations.id
        AND unread.sender_id != my_member.user_id
        AND unread.deleted_at IS NULL
        AND unread.id > COALESCE(my_member.last_read_message_id, 0)
    ) AS unread_count,
    CASE WHEN you_blocked.blocker_id IS NOT NULL OR they_blocked.blocker_id IS NOT NULL THEN 1 ELSE 0 END AS blocked,
    CASE WHEN pinned.user_id IS NOT NULL THEN 1 ELSE 0 END AS pinned
  FROM conversations
  JOIN conversation_members my_member ON my_member.conversation_id = conversations.id AND my_member.user_id = ?
  JOIN conversation_members other_member ON other_member.conversation_id = conversations.id AND other_member.user_id != ?
  JOIN users other_user ON other_user.id = other_member.user_id
  LEFT JOIN messages last_message ON last_message.id = (
    SELECT id FROM messages WHERE conversation_id = conversations.id AND deleted_at IS NULL ORDER BY id DESC LIMIT 1
  )
  LEFT JOIN blocks you_blocked ON you_blocked.blocker_id = my_member.user_id AND you_blocked.blocked_id = other_user.id
  LEFT JOIN blocks they_blocked ON they_blocked.blocker_id = other_user.id AND they_blocked.blocked_id = my_member.user_id
  LEFT JOIN conversation_pins pinned ON pinned.user_id = my_member.user_id AND pinned.conversation_id = conversations.id
  WHERE conversations.kind = 'direct'
    AND NOT EXISTS (SELECT 1 FROM group_conversations g WHERE g.conversation_id = conversations.id)
  ORDER BY pinned DESC, COALESCE(last_message.created_at, conversations.created_at) DESC
`);
const setConversationPin = database.prepare('INSERT INTO conversation_pins (user_id, conversation_id, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id, conversation_id) DO NOTHING');
const clearConversationPin = database.prepare('DELETE FROM conversation_pins WHERE user_id = ? AND conversation_id = ?');
const listMessages = database.prepare(`
  SELECT messages.id, messages.body, messages.ciphertext, messages.iv, messages.salt, messages.sender_public_key, messages.recipient_public_key, messages.group_keys_json,
    messages.client_message_id, messages.encryption_version, messages.created_at, messages.edited_at, messages.reply_to_message_id,
    users.id AS sender_id, users.username AS sender_username, users.avatar_url AS sender_avatar_url, users.name_style_json AS sender_name_style_json, users.custom_badges_json AS sender_custom_badges_json, users.is_verified AS sender_verified,
    reply.id AS reply_id, reply.body AS reply_body, reply.ciphertext AS reply_ciphertext, reply.deleted_at AS reply_deleted_at,
    reply.encryption_version AS reply_encryption_version, reply.group_keys_json AS reply_group_keys_json, reply_user.username AS reply_username,
    reply.iv AS reply_iv, reply.salt AS reply_salt, reply.sender_public_key AS reply_sender_key,
    reply.recipient_public_key AS reply_recipient_key, reply.client_message_id AS reply_client_id, reply.sender_id AS reply_sender_id
  FROM messages JOIN users ON users.id = messages.sender_id
  LEFT JOIN messages reply ON reply.id = messages.reply_to_message_id
  LEFT JOIN users reply_user ON reply_user.id = reply.sender_id
  WHERE messages.conversation_id = ? AND messages.deleted_at IS NULL AND messages.id < ? AND messages.id > ?
  ORDER BY messages.id DESC LIMIT ?
`);
const listLatestMessages = database.prepare(`
  SELECT messages.id, messages.body, messages.ciphertext, messages.iv, messages.salt, messages.sender_public_key, messages.recipient_public_key, messages.group_keys_json,
    messages.client_message_id, messages.encryption_version, messages.created_at, messages.edited_at, messages.reply_to_message_id,
    users.id AS sender_id, users.username AS sender_username, users.avatar_url AS sender_avatar_url, users.name_style_json AS sender_name_style_json, users.custom_badges_json AS sender_custom_badges_json, users.is_verified AS sender_verified,
    reply.id AS reply_id, reply.body AS reply_body, reply.ciphertext AS reply_ciphertext, reply.deleted_at AS reply_deleted_at,
    reply.encryption_version AS reply_encryption_version, reply.group_keys_json AS reply_group_keys_json, reply_user.username AS reply_username,
    reply.iv AS reply_iv, reply.salt AS reply_salt, reply.sender_public_key AS reply_sender_key,
    reply.recipient_public_key AS reply_recipient_key, reply.client_message_id AS reply_client_id, reply.sender_id AS reply_sender_id
  FROM messages JOIN users ON users.id = messages.sender_id
  LEFT JOIN messages reply ON reply.id = messages.reply_to_message_id
  LEFT JOIN users reply_user ON reply_user.id = reply.sender_id
  WHERE messages.conversation_id = ? AND messages.deleted_at IS NULL AND messages.id > ?
  ORDER BY messages.id DESC LIMIT ?
`);
const insertMessage = database.prepare(`
  INSERT INTO messages (id, conversation_id, sender_id, body, ciphertext, iv, salt, sender_public_key, recipient_public_key, client_message_id, encryption_version, created_at, reply_to_message_id)
  VALUES ((SELECT last_id + 1 FROM dm_message_sequence WHERE singleton = 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateMessageGroupKeys = database.prepare('UPDATE messages SET group_keys_json = ? WHERE id = ?');
const loadDirectMessageRow = database.prepare(`
  SELECT messages.id, messages.body, messages.ciphertext, messages.iv, messages.salt, messages.sender_public_key, messages.recipient_public_key, messages.group_keys_json,
    messages.client_message_id, messages.encryption_version, messages.created_at, messages.edited_at, messages.reply_to_message_id, messages.deleted_at,
    users.id AS sender_id, users.username AS sender_username, users.avatar_url AS sender_avatar_url, users.name_style_json AS sender_name_style_json, users.custom_badges_json AS sender_custom_badges_json, users.is_verified AS sender_verified,
    reply.id AS reply_id, reply.body AS reply_body, reply.ciphertext AS reply_ciphertext, reply.deleted_at AS reply_deleted_at,
    reply.encryption_version AS reply_encryption_version, reply.group_keys_json AS reply_group_keys_json, reply_user.username AS reply_username,
    reply.iv AS reply_iv, reply.salt AS reply_salt, reply.sender_public_key AS reply_sender_key,
    reply.recipient_public_key AS reply_recipient_key, reply.client_message_id AS reply_client_id, reply.sender_id AS reply_sender_id
  FROM messages JOIN users ON users.id = messages.sender_id
  LEFT JOIN messages reply ON reply.id = messages.reply_to_message_id
  LEFT JOIN users reply_user ON reply_user.id = reply.sender_id
  WHERE messages.id = ?
`);
const findMessageByClientId = database.prepare('SELECT id FROM messages WHERE conversation_id = ? AND sender_id = ? AND client_message_id = ?');
const findDirectMessage = database.prepare(`
  SELECT messages.id, messages.conversation_id, messages.sender_id, messages.body, messages.ciphertext, messages.encryption_version,
    messages.deleted_at, messages.edited_at, messages.created_at, messages.client_message_id, messages.reply_to_message_id,
    users.username AS sender_username, users.avatar_url AS sender_avatar_url
  FROM messages JOIN users ON users.id = messages.sender_id
  WHERE messages.id = ?
`);
const updateDirectMessage = database.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?');
const softDeleteDirectMessage = database.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?');
const findDirectReplyParent = database.prepare(`
  SELECT id, conversation_id, body, ciphertext, encryption_version, deleted_at, sender_id FROM messages WHERE id = ?
`);
const deleteMessage = database.prepare('DELETE FROM messages WHERE id = ?');
const listConversationMemberIds = database.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?');
const listDirectMessageUploadsForUser = database.prepare(`
  SELECT DISTINCT message_attachments.storage_name
  FROM message_attachments
  JOIN conversation_members ON conversation_members.conversation_id = message_attachments.conversation_id
  WHERE conversation_members.user_id = ? AND NOT EXISTS (SELECT 1 FROM group_conversations g WHERE g.conversation_id = message_attachments.conversation_id)
`);
const deleteDirectConversationsForUser = database.prepare('DELETE FROM conversations WHERE id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ?) AND NOT EXISTS (SELECT 1 FROM group_conversations g WHERE g.conversation_id = conversations.id)');
const deleteDirectMessagePinsForUser = database.prepare('DELETE FROM conversation_pins WHERE user_id = ?');
const markConversationRead = database.prepare(`
  UPDATE conversation_members SET last_read_message_id = CASE
    WHEN last_read_message_id IS NULL OR last_read_message_id < ? THEN ?
    ELSE last_read_message_id
  END
  WHERE conversation_id = ? AND user_id = ?
`);
const maxConversationMessageId = database.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ? AND deleted_at IS NULL');
const countConversationUnread = database.prepare(`
  SELECT COUNT(*) AS count FROM messages
  WHERE conversation_id = ? AND sender_id != ? AND deleted_at IS NULL AND id > COALESCE((
    SELECT last_read_message_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?
  ), 0)
`);
const countAllDmUnread = database.prepare(`
  SELECT COUNT(*) AS count
  FROM messages
  JOIN conversation_members ON conversation_members.conversation_id = messages.conversation_id AND conversation_members.user_id = ?
  WHERE messages.sender_id != ? AND messages.deleted_at IS NULL AND messages.id > COALESCE(conversation_members.last_read_message_id, 0)
    AND NOT EXISTS (SELECT 1 FROM user_conversation_mutes mute WHERE mute.user_id=conversation_members.user_id AND mute.conversation_id=messages.conversation_id)
`);
const countIncomingFriendRequests = database.prepare("SELECT COUNT(*) AS count FROM friend_requests WHERE receiver_id = ? AND status = 'pending'");
const maxChannelMessageId = database.prepare('SELECT MAX(id) AS id FROM channel_messages WHERE channel_id = ? AND deleted_at IS NULL');
const upsertChannelRead = database.prepare(`
  INSERT INTO channel_reads (channel_id, user_id, last_read_message_id)
  VALUES (?, ?, ?)
  ON CONFLICT(channel_id, user_id) DO UPDATE SET
    last_read_message_id = CASE
      WHEN excluded.last_read_message_id > channel_reads.last_read_message_id THEN excluded.last_read_message_id
      ELSE channel_reads.last_read_message_id
    END
`);
const deleteChannelMentions = database.prepare('DELETE FROM channel_message_mentions WHERE message_id = ?');
const insertChannelMention = database.prepare('INSERT OR IGNORE INTO channel_message_mentions (message_id, user_id) VALUES (?, ?)');
const listChannelUnreads = database.prepare(`
  SELECT
    server_channels.server_id AS server_id,
    server_channels.id AS channel_id,
    (
      SELECT COUNT(*) FROM channel_messages
      WHERE channel_messages.channel_id = server_channels.id
        AND channel_messages.deleted_at IS NULL
        AND channel_messages.user_id != ?
        AND channel_messages.id > COALESCE(channel_reads.last_read_message_id, 0)
    ) AS unread_count,
    (
      SELECT COUNT(*)
      FROM channel_message_mentions
      JOIN channel_messages ON channel_messages.id = channel_message_mentions.message_id
      WHERE channel_message_mentions.user_id = ?
        AND channel_messages.channel_id = server_channels.id
        AND channel_messages.deleted_at IS NULL
        AND channel_messages.user_id != ?
        AND channel_messages.id > COALESCE(channel_reads.last_read_message_id, 0)
    ) AS mention_count
  FROM server_channels
  JOIN server_members ON server_members.server_id = server_channels.server_id AND server_members.user_id = ?
  LEFT JOIN channel_reads ON channel_reads.channel_id = server_channels.id AND channel_reads.user_id = ?
  WHERE server_channels.voice = 0
`);
const listChannelUnreadsForServer = database.prepare(`
  SELECT
    server_channels.id AS channel_id,
    (
      SELECT COUNT(*) FROM channel_messages
      WHERE channel_messages.channel_id = server_channels.id
        AND channel_messages.deleted_at IS NULL
        AND channel_messages.user_id != ?
        AND channel_messages.id > COALESCE(channel_reads.last_read_message_id, 0)
    ) AS unread_count,
    (
      SELECT COUNT(*)
      FROM channel_message_mentions
      JOIN channel_messages ON channel_messages.id = channel_message_mentions.message_id
      WHERE channel_message_mentions.user_id = ?
        AND channel_messages.channel_id = server_channels.id
        AND channel_messages.deleted_at IS NULL
        AND channel_messages.user_id != ?
        AND channel_messages.id > COALESCE(channel_reads.last_read_message_id, 0)
    ) AS mention_count
  FROM server_channels
  LEFT JOIN channel_reads ON channel_reads.channel_id = server_channels.id AND channel_reads.user_id = ?
  WHERE server_channels.server_id = ? AND server_channels.voice = 0
`);
const listUnreadReadPositions = database.prepare('SELECT c.id, COALESCE(r.last_read_message_id, 0) AS last_read FROM server_channels c LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = ? WHERE c.server_id = ? AND c.voice = 0');
const countLiveAfter = database.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE channel_id = ? AND id > ? AND deleted_at IS NULL');
const countOwnLiveAfter = database.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE channel_id = ? AND user_id = ? AND id > ? AND deleted_at IS NULL');
// Start from this user's sparse mentions, not every retained channel message.
const countMentionLiveAfter = database.prepare('SELECT COUNT(*) AS n FROM channel_message_mentions v CROSS JOIN channel_messages m ON m.id = v.message_id WHERE v.user_id = ? AND m.channel_id = ? AND v.message_id > ? AND m.deleted_at IS NULL AND m.user_id != ?');
const insertAttachment = database.prepare(`
  INSERT INTO message_attachments (message_id, conversation_id, uploaded_by, storage_name, original_name, mime_type, size_bytes, encrypted, iv, salt, sender_public_key, recipient_public_key, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const listAttachmentsForMessage = database.prepare(`
  SELECT id, original_name, mime_type, size_bytes, encrypted, iv, salt, sender_public_key, recipient_public_key
  FROM message_attachments WHERE message_id = ? ORDER BY id ASC
`);
const findAttachmentForMember = database.prepare(`
  SELECT message_attachments.storage_name, message_attachments.original_name, message_attachments.mime_type, message_attachments.encrypted
  FROM message_attachments JOIN conversation_members ON conversation_members.conversation_id = message_attachments.conversation_id
  JOIN messages ON messages.id = message_attachments.message_id
  WHERE message_attachments.id = ? AND conversation_members.user_id = ?
    AND messages.deleted_at IS NULL AND messages.id > conversation_members.joined_after_message_id
`);
const listServers = database.prepare('SELECT servers.id, servers.name, servers.owner_id, servers.icon_url, servers.description, servers.banner_json, servers.created_at, servers.moderation_enabled, servers.is_public FROM servers JOIN server_members ON server_members.server_id = servers.id WHERE server_members.user_id = ? ORDER BY server_members.sort_order, servers.id');
const listMutedServerIds = database.prepare('SELECT server_id FROM user_server_mutes WHERE user_id = ?');
const findServerMute = database.prepare('SELECT 1 FROM user_server_mutes WHERE user_id = ? AND server_id = ?');
const setServerMute = database.prepare('INSERT INTO user_server_mutes (user_id, server_id, muted_at) VALUES (?, ?, ?) ON CONFLICT(user_id, server_id) DO UPDATE SET muted_at = excluded.muted_at');
const clearServerMute = database.prepare('DELETE FROM user_server_mutes WHERE user_id = ? AND server_id = ?');
const listAllServers = database.prepare('SELECT id, name, owner_id, icon_url, description, banner_json, created_at, moderation_enabled, is_public FROM servers ORDER BY id');
const listPublicServers = database.prepare(`
  SELECT servers.id, servers.name, servers.icon_url, servers.description,
    (SELECT COUNT(*) FROM server_members WHERE server_members.server_id = servers.id) AS member_count,
    EXISTS(SELECT 1 FROM server_members WHERE server_members.server_id = servers.id AND server_members.user_id = ?) AS is_member
  FROM servers
  WHERE servers.is_public = 1 AND (? = '' OR lower(servers.name) LIKE lower(?) OR lower(servers.description) LIKE lower(?))
  ORDER BY member_count DESC, servers.id DESC
  LIMIT ? OFFSET ?
`);
const listUsersForAdmin = database.prepare('SELECT id, username, is_admin FROM users WHERE username IS NOT NULL AND is_bot = 0');
const countAuthServers = database.prepare('SELECT COUNT(*) AS count FROM servers');
const setUserAdminFlag = database.prepare('UPDATE users SET is_admin = 1 WHERE id = ?');
const findServerMember = database.prepare('SELECT server_members.role_id, server_roles.name AS role_name, server_roles.permissions, server_roles.permission_flags FROM server_members JOIN server_roles ON server_roles.id = server_members.role_id WHERE server_members.server_id = ? AND server_members.user_id = ?');
const insertServerAudit = database.prepare('INSERT INTO server_audit_log (server_id, actor_user_id, actor_name, action, target_type, target_id, target_name, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const listServerAudit = database.prepare('SELECT id, actor_user_id AS actorUserId, actor_name AS actorName, action, target_type AS targetType, target_id AS targetId, target_name AS targetName, details_json AS detailsJson, created_at AS createdAt FROM server_audit_log WHERE server_id = ? AND id < ? ORDER BY id DESC LIMIT ?');
const listServerMembers = database.prepare(`
  SELECT users.id, users.username, users.avatar_url, users.bio, users.name_style_json, users.custom_badges_json, users.is_bot, users.is_verified, server_members.role_id, server_roles.name AS role_name, server_roles.color AS role_color, server_roles.permissions, server_roles.permission_flags, server_timeouts.until AS timeout_until
  FROM server_members
  JOIN users ON users.id = server_members.user_id
  JOIN server_roles ON server_roles.id = server_members.role_id
  LEFT JOIN server_timeouts ON server_timeouts.server_id = server_members.server_id AND server_timeouts.user_id = server_members.user_id
  WHERE server_members.server_id = ?
  ORDER BY server_roles.position DESC, users.username COLLATE NOCASE
`);
const listServerMembersPage = database.prepare(`
  SELECT users.id, users.username, users.avatar_url, users.bio, users.name_style_json, users.custom_badges_json, users.is_bot, users.is_verified, server_members.role_id, server_roles.name AS role_name, server_roles.color AS role_color, server_roles.permissions, server_roles.permission_flags, server_timeouts.until AS timeout_until
  FROM server_members
  JOIN users ON users.id = server_members.user_id
  JOIN server_roles ON server_roles.id = server_members.role_id
  LEFT JOIN server_timeouts ON server_timeouts.server_id = server_members.server_id AND server_timeouts.user_id = server_members.user_id
  WHERE server_members.server_id = ?
  ORDER BY server_roles.position DESC, users.username COLLATE NOCASE
  LIMIT ? OFFSET ?
`);
const countServerMembers = database.prepare('SELECT COUNT(*) AS count FROM server_members WHERE server_id = ?');
const countServerMembersByRole = database.prepare('SELECT role_id AS roleId, COUNT(*) AS count FROM server_members WHERE server_id = ? GROUP BY role_id');
const listServerMemberIds = database.prepare('SELECT DISTINCT user_id FROM server_members WHERE server_id = ?');
const listServerMentionNames = database.prepare('SELECT users.id, users.username FROM server_members JOIN users ON users.id = server_members.user_id WHERE server_members.server_id = ?');
const listServerChannels = database.prepare("SELECT server_channels.id, name, kind, voice, position, category_id, channel_kind, locked, slowmode, topic, cleanup.interval_seconds AS cleanup_interval_seconds, cleanup.next_run_at AS cleanup_next_run_at, bot_channels.active AS nura_active FROM server_channels LEFT JOIN channel_message_cleanup_schedules cleanup ON cleanup.channel_id = server_channels.id LEFT JOIN server_bot_channels bot_channels ON bot_channels.channel_id = server_channels.id AND bot_channels.bot_key = 'nura' WHERE server_channels.server_id = ? ORDER BY position, server_channels.id");
const listNuraServerHistory = database.prepare(`
  SELECT channel_messages.body, channel_messages.user_id, users.username, users.is_bot
  FROM channel_messages JOIN users ON users.id = channel_messages.user_id
  WHERE channel_messages.channel_id = ? AND channel_messages.deleted_at IS NULL
  ORDER BY channel_messages.id DESC LIMIT 12
`);
const listInstalledServerBots = database.prepare('SELECT installs.bot_key AS id, users.username AS name, users.avatar_url AS avatar_url, installs.installed_at AS installed_at FROM server_bot_installs installs JOIN users ON users.id = installs.bot_user_id WHERE installs.server_id = ? ORDER BY installs.installed_at, installs.bot_key');
const serverHasNura = database.prepare("SELECT 1 FROM server_bot_installs WHERE server_id = ? AND bot_key = 'nura'");
const installServerBot = database.prepare('INSERT INTO server_bot_installs (server_id, bot_key, bot_user_id, installed_by, installed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(server_id, bot_key) DO NOTHING');
const uninstallServerBot = database.prepare('DELETE FROM server_bot_installs WHERE server_id = ? AND bot_key = ?');
const findServerDefaultMemberRole = database.prepare("SELECT id FROM server_roles WHERE server_id = ? AND permissions = 'member' ORDER BY position ASC, id ASC LIMIT 1");
const removeServerBotMember = database.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?');
const upsertNuraChannelActivation = database.prepare("INSERT INTO server_bot_channels (server_id, channel_id, bot_key, active, activated_by, updated_at) VALUES (?, ?, 'nura', ?, ?, ?) ON CONFLICT(channel_id, bot_key) DO UPDATE SET active = excluded.active, activated_by = excluded.activated_by, updated_at = excluded.updated_at");
const getNuraChannelActivation = database.prepare("SELECT active FROM server_bot_channels WHERE channel_id = ? AND bot_key = 'nura'");
const listServerRoles = database.prepare('SELECT id, name, color, permissions, permission_flags, position FROM server_roles WHERE server_id = ? ORDER BY position DESC, id');
const channelMessageSelect = `
  SELECT channel_messages.id, channel_messages.channel_id, channel_messages.body, channel_messages.created_at, channel_messages.edited_at, channel_messages.reply_to_message_id, channel_messages.poll_json,
    users.id AS user_id, users.username, users.avatar_url, users.bio, users.name_style_json, users.custom_badges_json, users.is_bot, users.is_verified,
    reply.id AS reply_id, reply.body AS reply_body, reply.deleted_at AS reply_deleted_at, reply.poll_json AS reply_poll_json, reply_user.username AS reply_username
  FROM channel_messages
  JOIN users ON users.id = channel_messages.user_id
  LEFT JOIN channel_messages reply ON reply.id = channel_messages.reply_to_message_id
  LEFT JOIN users reply_user ON reply_user.id = reply.user_id
`;
const pageChannelMessages = database.prepare(`
  ${channelMessageSelect}
  WHERE channel_messages.channel_id = ? AND channel_messages.deleted_at IS NULL AND channel_messages.id < ?
  ORDER BY channel_messages.id DESC
  LIMIT ?
`);
const latestChannelMessages = database.prepare(`
  ${channelMessageSelect}
  WHERE channel_messages.channel_id = ? AND channel_messages.deleted_at IS NULL
  ORDER BY channel_messages.id DESC
  LIMIT ?
`);
const getChannelMessageRow = database.prepare(`
  ${channelMessageSelect}
  WHERE channel_messages.id = ? AND channel_messages.channel_id = ? AND channel_messages.deleted_at IS NULL
`);
const listChannelMessageReactions = database.prepare('SELECT reactions.message_id, reactions.emoji, COUNT(*) AS count, SUM(CASE WHEN reactions.user_id = ? THEN 1 ELSE 0 END) AS reacted FROM channel_message_reactions reactions JOIN channel_messages ON channel_messages.id = reactions.message_id WHERE channel_messages.channel_id = ? AND channel_messages.deleted_at IS NULL GROUP BY reactions.message_id, reactions.emoji ORDER BY reactions.emoji');
const insertServer = database.prepare('INSERT INTO servers (name, owner_id, created_at) VALUES (?, ?, ?)');
const insertRole = database.prepare('INSERT INTO server_roles (server_id, name, color, permissions, position) VALUES (?, ?, ?, ?, ?)');
const setRolePermissions = database.prepare('UPDATE server_roles SET permissions = ? WHERE id = ? AND server_id = ?');
const findServerRoleByName = database.prepare('SELECT id FROM server_roles WHERE server_id = ? AND lower(name) = lower(?)');
const findServerRole = database.prepare('SELECT id, server_id, name, color, permissions, permission_flags, position FROM server_roles WHERE id = ? AND server_id = ?');
const updateServerRole = database.prepare('UPDATE server_roles SET name = ?, color = ?, permissions = ?, permission_flags = ? WHERE id = ? AND server_id = ?');
const updateServerRolePosition = database.prepare('UPDATE server_roles SET position = ? WHERE id = ? AND server_id = ?');
const reassignRoleMembers = database.prepare("UPDATE server_members SET role_id = (SELECT id FROM server_roles WHERE server_id = ? AND permissions = 'member' ORDER BY position ASC, id ASC LIMIT 1) WHERE server_id = ? AND role_id = ?");
const deleteServerRole = database.prepare('DELETE FROM server_roles WHERE id = ? AND server_id = ?');
const insertMember = database.prepare('INSERT INTO server_members (server_id, user_id, role_id, joined_at, sort_order) VALUES (?, ?, ?, ?, ?)');
const nextMemberSortOrder = database.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM server_members WHERE user_id = ?');
const listMemberServerIds = database.prepare('SELECT server_id FROM server_members WHERE user_id = ? ORDER BY sort_order, server_id');
const updateMemberSortOrder = database.prepare('UPDATE server_members SET sort_order = ? WHERE server_id = ? AND user_id = ?');
const updateChannelPosition = database.prepare('UPDATE server_channels SET position = ? WHERE id = ? AND server_id = ?');
const insertChannel = database.prepare('INSERT INTO server_channels (server_id, name, kind, position) VALUES (?, ?, \'text\', ?)');
const insertChannelMessage = database.prepare('INSERT INTO channel_messages (channel_id, user_id, body, created_at, reply_to_message_id, poll_json) VALUES (?, ?, ?, ?, ?, ?)');
const listModerationContext = database.prepare('SELECT body FROM channel_messages WHERE channel_id = ? AND id < ? AND deleted_at IS NULL AND body <> ? ORDER BY id DESC LIMIT 4');
const getChannelMessagePoll = database.prepare('SELECT poll_json FROM channel_messages WHERE id = ?');
const updateChannelPoll = database.prepare('UPDATE channel_messages SET poll_json = ? WHERE id = ?');
const insertPollVote = database.prepare('INSERT OR IGNORE INTO channel_poll_votes (message_id, user_id, option_index, created_at) VALUES (?, ?, ?, ?)');
const deletePollVote = database.prepare('DELETE FROM channel_poll_votes WHERE message_id = ? AND user_id = ? AND option_index = ?');
const deleteUserPollVotes = database.prepare('DELETE FROM channel_poll_votes WHERE message_id = ? AND user_id = ?');
const findPollVote = database.prepare('SELECT option_index FROM channel_poll_votes WHERE message_id = ? AND user_id = ? AND option_index = ?');
const hardDeleteChannelMessage = database.prepare('DELETE FROM channel_messages WHERE id = ?');
const insertChannelAttachment = database.prepare(`
  INSERT INTO channel_message_attachments (message_id, channel_id, uploaded_by, storage_name, original_name, mime_type, size_bytes, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const listChannelAttachmentsForMessage = database.prepare(`
  SELECT id, original_name, mime_type, size_bytes FROM channel_message_attachments WHERE message_id = ? ORDER BY id ASC
`);
const listChannelAttachmentsForChannel = database.prepare(`
  SELECT id, message_id, original_name, mime_type, size_bytes FROM channel_message_attachments WHERE channel_id = ? ORDER BY id ASC
`);
const countChannelAttachmentsForMessage = database.prepare('SELECT COUNT(*) AS count FROM channel_message_attachments WHERE message_id = ?');
const listChannelAttachmentStorageForChannel = database.prepare('SELECT storage_name FROM channel_message_attachments WHERE channel_id = ?');
const deleteAllChannelMessages = database.prepare('DELETE FROM channel_messages WHERE channel_id = ?');
const dueChannelMessageCleanup = database.prepare('SELECT channel_message_cleanup_schedules.channel_id, server_channels.server_id, channel_message_cleanup_schedules.interval_seconds FROM channel_message_cleanup_schedules JOIN server_channels ON server_channels.id = channel_message_cleanup_schedules.channel_id WHERE channel_message_cleanup_schedules.next_run_at <= ? AND server_channels.voice = 0 ORDER BY channel_message_cleanup_schedules.next_run_at LIMIT 50');
const listChannelCleanupUploads = database.prepare('SELECT storage_name FROM channel_message_attachments WHERE channel_id = ?');
const updateChannelCleanupSchedule = database.prepare('INSERT INTO channel_message_cleanup_schedules (channel_id, interval_seconds, next_run_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET interval_seconds = excluded.interval_seconds, next_run_at = excluded.next_run_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at');
const deleteChannelCleanupSchedule = database.prepare('DELETE FROM channel_message_cleanup_schedules WHERE channel_id = ?');
const updateChannelCleanupNextRun = database.prepare('UPDATE channel_message_cleanup_schedules SET next_run_at = ?, updated_at = ? WHERE channel_id = ?');
const listChannelAttachmentStorageForServer = database.prepare(`
  SELECT channel_message_attachments.storage_name FROM channel_message_attachments
  JOIN server_channels ON server_channels.id = channel_message_attachments.channel_id
  WHERE server_channels.server_id = ?
`);
const findChannelAttachmentForMember = database.prepare(`
  SELECT channel_message_attachments.storage_name, channel_message_attachments.original_name, channel_message_attachments.mime_type
  FROM channel_message_attachments
  JOIN server_channels ON server_channels.id = channel_message_attachments.channel_id
  JOIN server_members ON server_members.server_id = server_channels.server_id
  JOIN channel_messages ON channel_messages.id = channel_message_attachments.message_id
  WHERE channel_message_attachments.id = ? AND server_members.user_id = ? AND channel_messages.deleted_at IS NULL
`);
const findChannelAttachmentById = database.prepare(`
  SELECT channel_message_attachments.storage_name, channel_message_attachments.original_name, channel_message_attachments.mime_type
  FROM channel_message_attachments
  JOIN channel_messages ON channel_messages.id = channel_message_attachments.message_id
  WHERE channel_message_attachments.id = ? AND channel_messages.deleted_at IS NULL
`);
const updateChannelMessage = database.prepare('UPDATE channel_messages SET body = ?, edited_at = ? WHERE id = ?');
const insertChannelReaction = database.prepare('INSERT OR IGNORE INTO channel_message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)');
const deleteChannelReaction = database.prepare('DELETE FROM channel_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?');
const findChannelReaction = database.prepare('SELECT 1 FROM channel_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?');
const isServerMember = database.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?');
const isServerBanned = database.prepare('SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?');
const isServerDeviceBanned = database.prepare('SELECT 1 FROM server_device_bans WHERE server_id = ? AND device_hash = ?');
const recordServerMemberDevice = database.prepare(`INSERT INTO server_member_devices(server_id,user_id,device_hash,first_seen,last_seen)
  VALUES(?,?,?,?,?) ON CONFLICT(server_id,user_id,device_hash) DO UPDATE SET last_seen=excluded.last_seen`);
const listServerMemberDeviceHashes = database.prepare('SELECT device_hash FROM server_member_devices WHERE server_id=? AND user_id=? ORDER BY last_seen DESC');
const listUsersSharingServerDevices = database.prepare(`SELECT DISTINCT user_id FROM server_member_devices
  WHERE server_id=? AND device_hash IN (SELECT device_hash FROM server_member_devices WHERE server_id=? AND user_id=?)`);
const insertServerDeviceBan = database.prepare('INSERT OR REPLACE INTO server_device_bans(server_id,device_hash,reason,created_at,created_by) VALUES(?,?,?,?,?)');
const deleteServerDeviceBan = database.prepare('DELETE FROM server_device_bans WHERE server_id=? AND device_hash=?');
const listServerDeviceBans = database.prepare(`SELECT server_device_bans.device_hash,server_device_bans.reason,server_device_bans.created_at,
  COALESCE(users.username,'Deleted user') AS banned_by FROM server_device_bans
  LEFT JOIN users ON users.id=server_device_bans.created_by WHERE server_device_bans.server_id=? ORDER BY server_device_bans.created_at DESC`);
const isChannelMember = database.prepare('SELECT 1 FROM server_members JOIN server_channels ON server_channels.server_id = server_members.server_id WHERE server_channels.id = ? AND server_members.user_id = ?');
const findChannel = database.prepare('SELECT server_channels.id, server_channels.server_id, server_channels.name, server_channels.voice, server_channels.position, server_channels.category_id, server_channels.channel_kind, server_channels.locked, server_channels.slowmode, server_channels.topic, servers.moderation_enabled FROM server_channels JOIN servers ON servers.id = server_channels.server_id WHERE server_channels.id = ?');
const updateChannelCategory = database.prepare('UPDATE server_channels SET category_id = ? WHERE id = ? AND server_id = ?');
const officialAnnouncements = createOfficialAnnouncements(database);
const findLastChannelMessageAt = database.prepare('SELECT created_at FROM channel_messages WHERE channel_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1');
const updateChannelSettings = database.prepare('UPDATE server_channels SET name = ?, topic = ?, locked = ?, slowmode = ?, channel_kind = ?, voice = ? WHERE id = ? AND server_id = ?');
const findServerTimeout = database.prepare('SELECT until FROM server_timeouts WHERE server_id = ? AND user_id = ?');
const upsertServerTimeout = database.prepare(`
  INSERT INTO server_timeouts (server_id, user_id, until, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(server_id, user_id) DO UPDATE SET until = excluded.until, reason = excluded.reason, created_by = excluded.created_by, created_at = excluded.created_at
`);
const deleteServerTimeout = database.prepare('DELETE FROM server_timeouts WHERE server_id = ? AND user_id = ?');
const deleteExpiredTimeouts = database.prepare('DELETE FROM server_timeouts WHERE until <= ?');
const findServerOwner = database.prepare('SELECT owner_id FROM servers WHERE id = ?');
const findServerById = database.prepare('SELECT id, name, owner_id, icon_url, description, banner_json, created_at, moderation_enabled, is_public FROM servers WHERE id = ?');
const updateServerProfile = database.prepare('UPDATE servers SET name = ?, description = ?, moderation_enabled = ?, is_public = ? WHERE id = ?');
const updateServerIcon = database.prepare('UPDATE servers SET icon_url = ? WHERE id = ?');
const updateServerBanner = database.prepare('UPDATE servers SET banner_json = ? WHERE id = ?');
const findServerByBannerUrl = database.prepare(`SELECT id FROM servers WHERE json_extract(banner_json, '$.kind') = 'image' AND (json_extract(banner_json, '$.imageUrl') = ? OR json_extract(banner_json, '$.imageUrl') = ?)`);
const insertCustomChannel = database.prepare('INSERT INTO server_channels (server_id, name, kind, voice, channel_kind, locked, slowmode, topic, position) VALUES (?, ?, \'text\', ?, ?, ?, 0, \'\', ?)');
const updateMemberRole = database.prepare('UPDATE server_members SET role_id = ? WHERE server_id = ? AND user_id = ?');
const findRole = database.prepare('SELECT id, server_id, permissions FROM server_roles WHERE id = ?');
const findChannelMessage = database.prepare('SELECT id, channel_id, user_id, deleted_at FROM channel_messages WHERE id = ?');
const listChannelMessageStorage = database.prepare('SELECT storage_name FROM channel_message_attachments WHERE message_id = ?');
const deleteChannelMessageReactions = database.prepare('DELETE FROM channel_message_reactions WHERE message_id = ?');
const deleteChannelMessageMentions = database.prepare('DELETE FROM channel_message_mentions WHERE message_id = ?');
const deleteChannelMessagePollVotes = database.prepare('DELETE FROM channel_poll_votes WHERE message_id = ?');
const deleteChannelMessageAttachments = database.prepare('DELETE FROM channel_message_attachments WHERE message_id = ?');
const deleteChannelMessage = database.prepare('DELETE FROM channel_messages WHERE id = ?');
const removeServerMember = database.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?');
const insertServerBan = database.prepare('INSERT OR REPLACE INTO server_bans (server_id, user_id, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?)');
const deleteServerBan = database.prepare('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?');
const insertServerInvite = database.prepare('INSERT INTO server_invites (code, server_id, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)');
const findServerInvite = database.prepare('SELECT code, server_id, expires_at, max_uses, uses FROM server_invites WHERE code = ?');
const listServerInvites = database.prepare(`
  SELECT server_invites.code, server_invites.created_at, server_invites.expires_at, server_invites.max_uses, server_invites.uses, users.username AS creator_username
  FROM server_invites JOIN users ON users.id = server_invites.created_by
  WHERE server_invites.server_id = ?
  ORDER BY server_invites.created_at DESC
`);
const deleteServerInvite = database.prepare('DELETE FROM server_invites WHERE code = ? AND server_id = ?');
const listServerBans = database.prepare(`
  SELECT server_bans.user_id, server_bans.reason, server_bans.created_at, users.username, users.avatar_url, COALESCE(creator.username, 'Deleted user') AS banned_by
  FROM server_bans
  JOIN users ON users.id = server_bans.user_id
  LEFT JOIN users creator ON creator.id = server_bans.created_by
  WHERE server_bans.server_id = ?
  ORDER BY server_bans.created_at DESC
`);
const incrementInviteUse = database.prepare('UPDATE server_invites SET uses = uses + 1 WHERE code = ? AND (max_uses = 0 OR uses < max_uses)');
const decrementInviteUse = database.prepare('UPDATE server_invites SET uses = CASE WHEN uses > 0 THEN uses - 1 ELSE 0 END WHERE code = ?');
const findDefaultMemberRole = database.prepare("SELECT id FROM server_roles WHERE server_id = ? AND permissions = 'member' ORDER BY position ASC, id ASC LIMIT 1");
const countServerChannels = database.prepare('SELECT COUNT(*) AS count FROM server_channels WHERE server_id = ?');
const removeServer = database.prepare('DELETE FROM servers WHERE id = ?');
const removeChannel = database.prepare('DELETE FROM server_channels WHERE id = ? AND server_id = ?');
const listLoopPosts = database.prepare(`
  SELECT loop_posts.id, loop_posts.user_id, loop_posts.body, loop_posts.media_type, loop_posts.created_at,
    users.username, users.avatar_url,
    (SELECT COUNT(*) FROM loop_post_likes WHERE loop_post_likes.post_id = loop_posts.id) AS likes,
    (SELECT COUNT(*) FROM loop_post_comments WHERE loop_post_comments.post_id = loop_posts.id) AS comments,
    EXISTS(SELECT 1 FROM loop_post_likes WHERE loop_post_likes.post_id = loop_posts.id AND loop_post_likes.user_id = ?) AS liked
  FROM loop_posts
  JOIN users ON users.id = loop_posts.user_id
  ORDER BY loop_posts.id DESC
  LIMIT ?
`);
const insertLoopPost = database.prepare('INSERT INTO loop_posts (user_id, body, media_type, client_id, created_at) VALUES (?, ?, ?, ?, ?)');
const findLoopPostByClientId = database.prepare('SELECT id FROM loop_posts WHERE user_id = ? AND client_id = ?');
const findLoopPost = database.prepare('SELECT id, user_id FROM loop_posts WHERE id = ?');
const loadLoopPost = database.prepare(`
  SELECT loop_posts.id, loop_posts.user_id, loop_posts.body, loop_posts.media_type, loop_posts.created_at,
    users.username, users.avatar_url,
    (SELECT COUNT(*) FROM loop_post_likes WHERE loop_post_likes.post_id = loop_posts.id) AS likes,
    (SELECT COUNT(*) FROM loop_post_comments WHERE loop_post_comments.post_id = loop_posts.id) AS comments,
    EXISTS(SELECT 1 FROM loop_post_likes WHERE loop_post_likes.post_id = loop_posts.id AND loop_post_likes.user_id = ?) AS liked
  FROM loop_posts JOIN users ON users.id = loop_posts.user_id WHERE loop_posts.id = ?
`);
const findLoopLike = database.prepare('SELECT 1 FROM loop_post_likes WHERE post_id = ? AND user_id = ?');
const insertLoopLike = database.prepare('INSERT OR IGNORE INTO loop_post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)');
const deleteLoopLike = database.prepare('DELETE FROM loop_post_likes WHERE post_id = ? AND user_id = ?');
const countLoopLikes = database.prepare('SELECT COUNT(*) AS count FROM loop_post_likes WHERE post_id = ?');
const insertLoopComment = database.prepare('INSERT INTO loop_post_comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)');
const countLoopComments = database.prepare('SELECT COUNT(*) AS count FROM loop_post_comments WHERE post_id = ?');

function normalizeEmail(value) {
  const clean = String(value || '').trim().toLowerCase();
  const localPart = clean.split('@')[0]?.replace(/[^a-z0-9._-]/g, '');
  return localPart ? `${localPart}@glean.io` : '';
}

function usernameFromPathSegment(value) {
  try {
    return normalizeUsername(decodeURIComponent(value));
  } catch {
    return '';
  }
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function publicKeyFingerprint(publicKey) {
  const canonical = JSON.stringify({ crv: publicKey.crv, kty: publicKey.kty, x: publicKey.x, y: publicKey.y });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function storedPublicKeyFingerprint(rawPublicKey, fingerprint) {
  if (typeof fingerprint === 'string' && /^[a-f0-9]{32}$/i.test(fingerprint)) return fingerprint.toLowerCase();
  try {
    const publicKey = JSON.parse(String(rawPublicKey || ''));
    if (!publicKey || typeof publicKey !== 'object' || Array.isArray(publicKey)) return null;
    return publicKeyFingerprint(publicKey);
  } catch { return null; }
}

function publicKeyMatchesStored(publicKey, rawPublicKey, fingerprint) {
  if (!publicKey || typeof publicKey !== 'object' || Array.isArray(publicKey)
    || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256'
    || typeof publicKey.x !== 'string' || typeof publicKey.y !== 'string') return false;
  const expected = storedPublicKeyFingerprint(rawPublicKey, fingerprint);
  return Boolean(expected && publicKeyFingerprint(publicKey) === expected);
}

function validAccountKeyBackup(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && value.version === 1 && value.kdf === 'PBKDF2-SHA256' && value.iterations === 600_000
    && typeof value.salt === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value.salt)
    && typeof value.iv === 'string' && /^[A-Za-z0-9_-]{16}$/.test(value.iv)
    && typeof value.ciphertext === 'string' && /^[A-Za-z0-9_-]{22,90000}$/.test(value.ciphertext));
}

function parseCookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie || '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)]),
  );
}

function bearerToken(request) {
  const value = String(request.headers.authorization || '').trim();
  const match = value.match(/^Bearer\s+([A-Za-z0-9_-]{32,128})$/i);
  return match ? match[1] : null;
}

function requestSessionToken(request) {
  return bearerToken(request) || parseCookies(request).glean_session || null;
}

function sendJson(response, statusCode, payload, headers = {}) {
  const bodyPayload = statusCode >= 400 && payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...payload, requestId: payload.requestId || response.getHeader('X-Request-Id') || null }
    : payload;
  const body = Buffer.from(JSON.stringify(bodyPayload));
  const accept = String(response.req?.headers?.['accept-encoding'] || '');
  const sendUncompressed = () => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    response.end(body);
  };
  if (body.byteLength > 16 * 1024 && /\bgzip\b/.test(accept) && !headers['Content-Encoding']) {
    gzip(body, { level: 4 }, (error, compressed) => {
      if (error) return sendUncompressed();
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Encoding': 'gzip',
        Vary: 'Accept-Encoding',
        'Content-Length': compressed.length,
        ...headers,
      });
      response.end(compressed);
    });
    return;
  }
  return sendUncompressed();
}

function sessionCookie(token, maxAge = sessionLifetimeSeconds) {
  const attributes = [`glean_session=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (isProduction) attributes.push('Secure');
  return attributes.join('; ');
}

function isPlatformAdmin(user) {
  if (!user) return false;
  if (Number(user.is_admin) === 1) return true;
  return PLATFORM_ADMIN_NAMES.has(String(user.username || '').toLowerCase());
}

function isNuperAdmin(user) {
  return Boolean(user && String(user.username || '').toLowerCase() === 'nuper' && isPlatformAdmin(user));
}

function showInspectServersFor(user) {
  return isPlatformAdmin(user) && Number(user.show_inspect_servers) !== 0;
}

function grantNamedPlatformAdmin(user) {
  if (!user?.id || Number(user.is_admin) === 1) return user;
  if (!PLATFORM_ADMIN_NAMES.has(String(user.username || '').toLowerCase())) return user;
  setUserAdminFlag.run(user.id);
  return { ...user, is_admin: 1 };
}

function listPlatformAdminIds() {
  return listUsersForAdmin.all().filter(isPlatformAdmin).map((item) => Number(item.id));
}

function canSeeServer(user, serverId) {
  return Boolean(isServerMember.get(serverId, user.id) || (isPlatformAdmin(user) && findServerById.get(serverId)));
}

function serverDeviceHash(request, serverId) {
  const installId = String(request.headers['x-glean-install-id'] || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(installId) || Buffer.from(installId, 'base64url').length !== 32) return null;
  return createHash('sha256').update(`${Number(serverId)}:${installId}`).digest('hex');
}

function canSeeChannel(user, channelId) {
  const channel = findChannel.get(channelId);
  if (!channel) return false;
  if (isChannelMember.get(channelId, user.id)) return true;
  if (!isPlatformAdmin(user)) return false;
  return true;
}

function canModerateServer(user, serverId) {
  if (!findServerById.get(serverId)) return false;
  if (isPlatformAdmin(user)) return true;
  const owner = findServerOwner.get(serverId);
  const actor = findServerMember.get(serverId, user.id);
  return Boolean(owner && (owner.owner_id === user.id || actor?.permissions === 'moderator'));
}

function writeServerAudit(serverId, actor, action, { targetType = '', targetId = '', targetName = '', details = {} } = {}) {
  try {
    const detailsJson = JSON.stringify(details && typeof details === 'object' ? details : {});
    insertServerAudit.run(
      Number(serverId), actor?.id ? Number(actor.id) : null,
      String(actor?.username || 'Unknown').slice(0, 32), String(action).slice(0, 80),
      String(targetType).slice(0, 40), String(targetId ?? '').slice(0, 80),
      String(targetName || '').slice(0, 120), detailsJson.length <= 4000 ? detailsJson : '{}',
      new Date().toISOString(),
    );
  } catch (error) {
    console.error('Could not write server audit entry:', error.message);
  }
}

const MODERATOR_FLAGS = ['manageChannels', 'manageMessages', 'manageMembers', 'manageInvites', 'postStaff', 'manageApps', 'manageRoles', 'manageServer', 'viewAuditLog', 'manageVoice'];
function roleFlags(row) {
  if (row?.permissions !== 'moderator') return [];
  if (row.permission_flags == null) return [...MODERATOR_FLAGS];
  try {
    const flags = JSON.parse(row.permission_flags);
    return Array.isArray(flags) ? flags.filter((flag) => MODERATOR_FLAGS.includes(flag)) : [];
  } catch { return []; }
}
function validRoleFlags(flags) {
  return Array.isArray(flags) && flags.every((flag) => typeof flag === 'string' && MODERATOR_FLAGS.includes(flag)) && new Set(flags).size === flags.length;
}
function canServerPermission(user, serverId, flag) {
  if (!findServerById.get(serverId)) return false;
  if (isPlatformAdmin(user) || findServerOwner.get(serverId)?.owner_id === user.id) return true;
  const member = findServerMember.get(serverId, user.id);
  return member?.permissions === 'moderator' && roleFlags(member).includes(flag);
}

function canOwnServer(user, serverId) {
  return Boolean(isPlatformAdmin(user) ? findServerById.get(serverId) : findServerOwner.get(serverId)?.owner_id === user.id);
}

const CHANNEL_CREATE_TYPES = new Set(['text', 'voice', 'announcement', 'rules']);
const CHANNEL_KINDS = new Set(['text', 'announcement', 'rules']);
const SLOWMODE_SECONDS = new Set([0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]);
const TIMEOUT_SECONDS = new Set([60, 300, 600, 3600, 21600, 86400, 604800]);

function sanitizeChannelName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
}

function channelKindFrom(type, name, voice) {
  if (voice) return 'text';
  const kind = String(type || '').toLowerCase();
  if (kind === 'announcement' || kind === 'rules') return kind;
  const clean = String(name || '').toLowerCase();
  if (clean === 'announcements' || clean === 'announcement') return 'announcement';
  if (clean === 'rules') return 'rules';
  return 'text';
}

function publicChannelKind(row) {
  if (row?.voice) return 'voice';
  if (row?.channel_kind === 'announcement' || row?.channel_kind === 'rules') return row.channel_kind;
  return channelKindFrom('', row?.name, row?.voice);
}

function channelIsStaffOnly(row) {
  if (!row || row.voice) return false;
  if (Boolean(Number(row.locked))) return true;
  const kind = publicChannelKind(row);
  return kind === 'announcement' || kind === 'rules';
}

function timeoutUntilFor(serverId, userId) {
  const row = findServerTimeout.get(serverId, userId);
  if (!row) return null;
  if (Date.parse(row.until) <= Date.now()) {
    deleteServerTimeout.run(serverId, userId);
    return null;
  }
  return row.until;
}

function postingBlockReason(user, channelRecord, { skipSlowmode = false } = {}) {
  const restriction = messageReports?.getRestriction(user.id);
  if (restriction) return `Your account is restricted until ${restriction.until}. ${restriction.reason}`;
  if (!channelRecord) return 'Channel not found.';
  if (channelRecord.voice) return 'Voice channels do not have messages.';
  const serverId = Number(channelRecord.server_id);
  if (timeoutUntilFor(serverId, user.id)) return 'You are timed out in this server.';
  if (officialAnnouncements.isServer(serverId) && publicChannelKind(channelRecord) === 'announcement') {
    return officialAnnouncements.canPost(user.id) ? null : 'Only the Glean owner can publish official announcements.';
  }
  if (canServerPermission(user, serverId, 'postStaff')) return null;
  if (channelIsStaffOnly(channelRecord)) {
    const kind = publicChannelKind(channelRecord);
    if (kind === 'rules') return 'Only moderators can post in rules.';
    if (kind === 'announcement') return 'Only moderators can post in announcements.';
    return 'This channel is locked.';
  }
  if (!skipSlowmode) {
    const slowmode = Number(channelRecord.slowmode || 0);
    if (slowmode > 0) {
      const last = findLastChannelMessageAt.get(channelRecord.id, user.id);
      if (last?.created_at) {
        const elapsed = (Date.now() - Date.parse(last.created_at)) / 1000;
        if (Number.isFinite(elapsed) && elapsed < slowmode) return `Slowmode: wait ${Math.max(1, Math.ceil(slowmode - elapsed))}s.`;
      }
    }
  }
  return null;
}

function parseIdList(value) {
  if (!Array.isArray(value)) return null;
  const ids = value.map((item) => Number(item));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return null;
  if (new Set(ids).size !== ids.length) return null;
  return ids;
}

function sameIdSet(left, right) {
  if (left.length !== right.length) return false;
  const wanted = new Set(left);
  return right.every((id) => wanted.has(id));
}

const BANNER_HEX = /^#[0-9a-f]{6}$/i;
const BANNER_FILE = /^banner-[a-z2-7]+\.(?:jpg|gif)$/;
const BANNER_URL = /^\/api\/v1\/banners\/(banner-[a-z2-7]+\.(?:jpg|gif))$/;
const SERVER_BANNER_FILE = /^server-banner-[a-z2-7]+\.jpg$/;
const SERVER_BANNER_URL = /^\/api\/v1\/server-banners\/(server-banner-[a-z2-7]+\.jpg)$/;
const SERVER_ICON_FILE = /^server-icon-[a-z2-7]+\.jpg$/;
const SERVER_ICON_URL = /^\/api\/v1\/server-icons\/(server-icon-[a-z2-7]+\.jpg)$/;

function bannerHex(value) {
  const clean = String(value || '').trim();
  if (BANNER_HEX.test(clean)) return `#${clean.slice(1).toLowerCase()}`;
  return null;
}

function imageMimeType(fileName) {
  const name = String(fileName || '').toLowerCase();
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function isGif(bytes) {
  if (bytes.length < 6) return false;
  const header = bytes.subarray(0, 6).toString('ascii');
  return header === 'GIF87a' || header === 'GIF89a';
}

const NAME_FONTS = new Set(NAME_FONT_IDS);

function publicNameStyle(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return null; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.font != null && data.font !== '' && !NAME_FONTS.has(String(data.font))) return null;
  const font = NAME_FONTS.has(data.font) && data.font !== 'lexend' ? data.font : null;
  let glow = 0;
  if (data.glow === true) glow = 50;
  else if (data.glow != null && data.glow !== false && data.glow !== '') {
    if (typeof data.glow !== 'number' && typeof data.glow !== 'string') return null;
    const amount = Math.round(Number(data.glow));
    if (!Number.isFinite(amount)) return null;
    glow = Math.min(100, Math.max(0, amount));
  }
  const next = {};
  if (data.kind === 'solid') {
    const color = bannerHex(data.color);
    if (!color) return null;
    next.kind = 'solid';
    next.color = color;
  } else if (data.kind === 'gradient') {
    const from = bannerHex(data.from);
    const to = bannerHex(data.to);
    const angle = Math.min(360, Math.max(0, Math.round(Number(data.angle) || 135)));
    if (!from || !to) return null;
    next.kind = 'gradient';
    next.from = from;
    next.to = to;
    next.angle = angle;
  } else if (data.kind != null && data.kind !== '' && data.kind !== 'none') {
    return null;
  }
  if (glow) next.glow = glow;
  if (font) next.font = font;
  return Object.keys(next).length ? next : null;
}

function publicBanner(raw, imageUrlTest = BANNER_URL) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return null; }
  }
  if (!data || typeof data !== 'object') return null;
  if (data.kind === 'solid') {
    const color = bannerHex(data.color);
    return color ? { kind: 'solid', color } : null;
  }
  if (data.kind === 'gradient') {
    const from = bannerHex(data.from);
    const to = bannerHex(data.to);
    const angle = Math.min(360, Math.max(0, Math.round(Number(data.angle) || 135)));
    return from && to ? { kind: 'gradient', from, to, angle } : null;
  }
  if (data.kind === 'image') {
    const imageUrl = String(data.imageUrl || '');
    return imageUrlTest.test(imageUrl) ? { kind: 'image', imageUrl } : null;
  }
  return null;
}

function publicProfileBackground(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return null; }
  }
  if (data?.kind === 'image' && typeof data.imageUrl === 'string' && PROFILE_BACKGROUND_URL.test(data.imageUrl)) {
    return { kind: 'image', imageUrl: data.imageUrl, ...profileImageAdjustments(data) };
  }
  const background = publicBanner(raw);
  return background?.kind === 'solid' || background?.kind === 'gradient' ? background : null;
}

function publicUserBadges(user) {
  const badges = [];
  if (String(user?.username || '').toLowerCase() === 'nuper') {
    badges.push({ id: 'owner', label: 'Owner' });
  }
  const createdAt = Date.parse(String(user?.created_at || ''));
  if (Number.isFinite(createdAt)) {
    const joined = new Date(createdAt);
    if (joined.getUTCMonth() === 8 && joined.getUTCDate() >= 11 && joined.getUTCDate() <= 15) {
      badges.push({ id: 'early-bird', label: 'Early Bird' });
    }
  }
  return badges;
}

function publicCustomBadges(value) {
  const parsed = Array.isArray(value) ? value : safeJsonParse(value);
  return normalizeCustomBadges(parsed || []) || [];
}

function publicServerBanner(raw) {
  return publicBanner(raw, SERVER_BANNER_URL);
}

function bannerFileName(banner) {
  if (banner?.kind !== 'image') return null;
  const imageUrl = String(banner.imageUrl || '');
  const userMatch = imageUrl.match(BANNER_URL);
  if (userMatch) return userMatch[1];
  const serverMatch = imageUrl.match(SERVER_BANNER_URL);
  return serverMatch ? serverMatch[1] : null;
}

function inviteScopedBanner(banner, code) {
  if (!banner) return null;
  if (banner.kind !== 'image') return banner;
  return { kind: 'image', imageUrl: `${apiPrefix}/invites/${code}/banner` };
}

function serverIconFileName(url) {
  const match = String(url || '').match(SERVER_ICON_URL);
  return match ? match[1] : null;
}

function publicServerSummary(server) {
  if (!server) return null;
  return {
    id: Number(server.id),
    name: server.name,
    ownerId: Number(server.owner_id),
    officialAnnouncements: officialAnnouncements.isServer(server.id),
    iconUrl: server.icon_url || null,
    description: server.description || '',
    banner: publicServerBanner(server.banner_json),
    moderationEnabled: Number(server.moderation_enabled) === 1,
    isPublic: Number(server.is_public) === 1,
    createdAt: server.created_at || null,
  };
}

function findInviteByCode(code) {
  const raw = String(code || '').trim();
  if (!raw) return null;
  return findServerInvite.get(raw) || (raw === raw.toLowerCase() ? null : findServerInvite.get(raw.toLowerCase()));
}

function parseInviteOptions(input = {}) {
  const requestedHours = Number(input.expiresInHours);
  const expiresInHours = Number.isFinite(requestedHours) ? Math.min(Math.max(Math.round(requestedHours), 1), 168) : 168;
  const maxUses = Number.isInteger(Number(input.maxUses)) ? Math.min(Math.max(Number(input.maxUses), 0), 1000) : 0;
  return { expiresInHours, maxUses, expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString() };
}

function createInviteRecord(serverId, userId, now, options = {}) {
  const { expiresAt, maxUses } = parseInviteOptions(options);
  let code = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = randomBase32(6);
    try {
      insertServerInvite.run(candidate, serverId, userId, now, expiresAt, maxUses);
      code = candidate;
      break;
    } catch { /* a generated code collision is safe to retry */ }
  }
  return code ? { code, serverId: Number(serverId), expiresAt, maxUses } : null;
}

function invitePreviewFor(invite, user, now, request = null) {
  const server = findServerById.get(invite.server_id);
  if (!server) return null;
  const members = listServerMemberIds.all(invite.server_id);
  let onlineCount = 0;
  for (const member of members) {
    const status = publicPresence(member.user_id);
    if (status === 'online' || status === 'idle') onlineCount += 1;
  }
  const expired = invite.expires_at <= now || (Number(invite.max_uses) > 0 && Number(invite.uses) >= Number(invite.max_uses));
  return {
    code: invite.code,
    expired,
    banned: Boolean(isServerBanned.get(invite.server_id, user.id)
      || (request && serverDeviceHash(request, invite.server_id)
        && isServerDeviceBanned.get(invite.server_id, serverDeviceHash(request, invite.server_id)))),
    alreadyMember: Boolean(isServerMember.get(invite.server_id, user.id)),
    server: {
      ...publicServerSummary(server),
      iconUrl: server.icon_url ? `${apiPrefix}/invites/${invite.code}/icon` : null,
      banner: inviteScopedBanner(publicServerBanner(server.banner_json), invite.code),
      memberCount: members.length,
      onlineCount,
    },
  };
}

const GRADE_LABELS = {
  below_hs: 'Below High School',
  9: '9th grade',
  10: '10th grade',
  11: '11th grade',
  12: '12th grade',
  no_response: null,
};
const GRADE_IDS = new Set(Object.keys(GRADE_LABELS));

function publicGrade(value) {
  const clean = String(value || '').trim();
  return GRADE_IDS.has(clean) ? clean : null;
}

function gradeLabel(value) {
  const grade = publicGrade(value);
  return grade ? GRADE_LABELS[grade] : null;
}

function publicSchool(value) {
  return normalizeSchool(value);
}

const CENSUS_GRADES = ['9', '10', '11', '12', 'below_hs'];

function monthKeyUtc(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function buildCommunityAnalytics() {
  const rows = listUserCensus.all();
  const gradeCounts = Object.fromEntries(CENSUS_GRADES.map((id) => [id, 0]));
  let gradeHidden = 0;
  const schoolCounts = new Map();
  let schoolHidden = 0;
  const programCounts = Object.fromEntries(PROGRAMS.map((item) => [item.id, 0]));
  let programHidden = 0;
  const joinCounts = new Map();
  let joinedThisWeek = 0;
  let joinedThisMonth = 0;
  let oldestAt = null;
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthCursor = new Date();
  const monthStart = Date.UTC(monthCursor.getUTCFullYear(), monthCursor.getUTCMonth(), 1);

  for (const row of rows) {
    const grade = publicGrade(row.grade);
    if (gradeLabel(grade)) gradeCounts[grade] += 1;
    else gradeHidden += 1;

    const school = publicSchool(row.school);
    if (schoolBadgeLabel(school)) schoolCounts.set(school, (schoolCounts.get(school) || 0) + 1);
    else schoolHidden += 1;

    const programIds = parseProgramJson(row.program_json);
    if (!programIds || programIds.includes('no_response')) programHidden += 1;
    else {
      for (const id of programIds) {
        if (Object.hasOwn(programCounts, id)) programCounts[id] += 1;
      }
    }

    const created = Date.parse(row.created_at);
    if (!Number.isFinite(created)) continue;
    if (!oldestAt || created < Date.parse(oldestAt)) oldestAt = row.created_at;
    if (created >= weekAgo) joinedThisWeek += 1;
    if (created >= monthStart) joinedThisMonth += 1;
    const key = monthKeyUtc(row.created_at);
    if (key) joinCounts.set(key, (joinCounts.get(key) || 0) + 1);
  }

  const grades = CENSUS_GRADES.map((id) => ({ id, label: GRADE_LABELS[id], count: gradeCounts[id] }));
  if (gradeHidden) grades.push({ id: 'hidden', label: 'Hidden', count: gradeHidden });

  const schools = [...schoolCounts.entries()]
    .map(([id, count]) => ({ id, label: schoolBadgeLabel(id), hex: schoolHex(id), count }))
    .sort((left, right) => right.count - left.count || String(left.label).localeCompare(String(right.label)));
  if (schoolHidden) schools.push({ id: 'hidden', label: 'Hidden', hex: null, count: schoolHidden });

  const programs = PROGRAMS.map((item) => ({ id: item.id, label: item.badge, hex: item.hex, count: programCounts[item.id] }));
  if (programHidden) programs.push({ id: 'hidden', label: 'Hidden', hex: null, count: programHidden });

  const joins = [];
  const today = new Date();
  for (let offset = 7; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - offset, 1));
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    joins.push({
      month,
      label: date.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      count: joinCounts.get(month) || 0,
    });
  }

  return {
    members: rows.length,
    joinedThisWeek,
    joinedThisMonth,
    oldestAt,
    grades,
    schools,
    programs,
    joins,
  };
}

function publicAccount(user) {
  const id = Number(user.id);
  const grade = publicGrade(user.grade);
  const school = publicSchool(user.school);
  return {
    id,
    agreementsAccepted: Boolean(findAgreementAcceptance.get(id, TERMS_VERSION, CONDUCT_VERSION)),
    termsVersion: TERMS_VERSION,
    conductVersion: CONDUCT_VERSION,
    email: user.email,
    username: user.username || null,
    verified: Number(user.is_verified) === 1,
    bio: user.bio || '',
    customBadges: publicCustomBadges(user.custom_badges_json),
    privateNotesEnabled: user.private_notes_enabled !== 0,
    presenceStatus: ['auto', 'online', 'idle', 'dnd', 'offline'].includes(user.presence_status) ? user.presence_status : 'auto',
    avatarUrl: user.avatar_url || null,
    banner: publicBanner(user.banner_json),
    profileBackground: publicProfileBackground(user.profile_background_json),
    mainThemes: normalizeMainThemes(user.main_theme_json),
    nameStyle: publicNameStyle(user.name_style_json),
    grade,
    gradeLabel: gradeLabel(grade),
    school,
    schoolLabel: schoolBadgeLabel(school),
    schoolHex: schoolHex(school),
    programAnswered: programAnswered(user.program_json),
    programs: publicPrograms(user.program_json),
    discordUsername: publicDiscordUsername(user.discord_username),
    socialLinks: { instagram: user.instagram_url || null, instagramUsername: user.instagram_username || null, tiktok: user.tiktok_url || null, tiktokUsername: user.tiktok_username || null },
    socialPromptSeen: Boolean(user.social_prompt_seen),
    surveyCompleted: Boolean(user.feedback_survey_completed_at),
    canViewSurveyResults: isNuperAdmin(user),
    canReviewReports: Boolean(messageReports?.canReview(user)),
    restriction: messageReports?.getRestriction(user.id) || null,
    badges: publicUserBadges(user),
    platformAdmin: isPlatformAdmin(user),
    e2ee: { enabled: Boolean(user.public_key_jwk), fingerprint: user.key_fingerprint || null },
    createdAt: user.created_at,
    presence: publicPresence(id),
    presenceHidden: Boolean(Number(user.presence_hidden)),
    keepInformationSecret: Boolean(Number(user.keep_information_secret)),
    showInspectServers: showInspectServersFor(user),
    accessibility: {
      contrast: Number(user.accessibility_contrast ?? 100),
      saturation: Number(user.accessibility_saturation ?? 100),
      reduceMotion: Boolean(Number(user.accessibility_reduce_motion)),
      glassFrost: Number(user.accessibility_glass_frost ?? 50),
      glassDepth: Number(user.accessibility_glass_depth ?? 20),
      glassRefraction: Number(user.accessibility_glass_refraction ?? 100),
      theme: ['system', 'light', 'dark'].includes(user.accessibility_theme) ? user.accessibility_theme : 'system',
      showLoopStreakReminder: user.accessibility_loop_streak_reminder == null ? true : Boolean(Number(user.accessibility_loop_streak_reminder)),
    },
  };
}

function readJson(request, maxBytes = 64 * 1024) {
  return new Promise((resolveJson, reject) => {
    const contentLength = Number(request.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      request.resume();
      reject(new Error('Request body is too large.'));
      return;
    }
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    };
    request.on('data', (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        fail(new Error('Request body is too large.'));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const value = totalBytes ? JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8')) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON body must be an object.');
        resolveJson(value);
      } catch (error) {
        reject(error.message === 'JSON body must be an object.' ? error : new Error('Invalid JSON body.'));
      }
    });
    request.on('aborted', () => fail(new Error('Request body was interrupted.')));
    request.on('error', fail);
  });
}

function safeFileName(value) {
  const fileName = String(value || 'file').replace(/[\\/\0]/g, '_').trim();
  return (fileName || 'file').slice(0, 180);
}

function safeJsonParse(value) { try { return value ? JSON.parse(value) : null; } catch { return null; } }

function attachmentPayload(attachment) {
  return {
    id: Number(attachment.id),
    name: attachment.original_name,
    type: attachment.mime_type,
    size: Number(attachment.size_bytes),
    url: `${apiPrefix}/attachments/${attachment.id}`,
    encrypted: Boolean(attachment.encrypted),
    crypto: attachment.encrypted ? {
      iv: attachment.iv, salt: attachment.salt,
      senderPublicKey: safeJsonParse(attachment.sender_public_key), recipientPublicKey: safeJsonParse(attachment.recipient_public_key),
    } : null,
  };
}

const blockedChannelMimeTypes = new Set([
  'text/html', 'application/xhtml+xml', 'text/javascript', 'application/javascript',
  'application/x-javascript', 'image/svg+xml', 'text/xml', 'application/xml',
]);

function sanitizeMimeType(value) {
  const mime = String(value || 'application/octet-stream').toLowerCase().split(';')[0].trim() || 'application/octet-stream';
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) || blockedChannelMimeTypes.has(mime)) return null;
  return mime.slice(0, 160);
}

const channelMimeByExtension = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.gif', 'image/gif'], ['.webp', 'image/webp'],
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mov', 'video/quicktime'], ['.ogv', 'video/ogg'], ['.m4v', 'video/mp4'],
  ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.ogg', 'audio/ogg'], ['.m4a', 'audio/mp4'], ['.aac', 'audio/aac'], ['.flac', 'audio/flac'], ['.oga', 'audio/ogg'],
  ['.pdf', 'application/pdf'], ['.txt', 'text/plain'], ['.zip', 'application/zip'],
]);

function channelFileMimeType(file) {
  const name = String(file?.name || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  if (['.svg', '.html', '.htm', '.js', '.mjs', '.xml'].includes(ext)) return null;
  const declared = sanitizeMimeType(file?.type || 'application/octet-stream');
  if (!declared) return null;
  if (declared !== 'application/octet-stream') return declared;
  return sanitizeMimeType(channelMimeByExtension.get(ext) || 'application/octet-stream');
}

function channelAttachmentPayload(attachment) {
  return {
    id: Number(attachment.id),
    name: attachment.original_name,
    type: attachment.mime_type,
    size: Number(attachment.size_bytes),
    url: `${apiPrefix}/channel-attachments/${attachment.id}`,
    encrypted: false,
    crypto: null,
  };
}

function removeStoredUploads(storageNames) {
  for (const storageName of storageNames) {
    try { unlinkSync(join(uploadDirectory, storageName)); } catch {}
  }
}

function parseReplyToId(value) {
  if (value == null || value === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function readMessageInput(request) {
  const contentType = String(request.headers['content-type'] || '');
  if (!contentType.startsWith('multipart/form-data')) {
    const input = await readJson(request);
    return {
      body: input.body,
      envelope: input.envelope || null,
      attachmentMeta: input.attachmentMeta || [],
      files: [],
      replyToMessageId: parseReplyToId(input.replyToMessageId),
      poll: Object.prototype.hasOwnProperty.call(input, 'poll') ? input.poll : null,
    };
  }

  const contentLength = Number(request.headers['content-length'] || 0);
  if (contentLength > MAX_ATTACHMENT_BYTES) throw new Error('Attachments can total up to 2 GB per message.');
  const parsed = await parseMultipart(request, {
    directory: uploadDirectory,
    nameFile: () => randomBase32(24),
  });
  let envelope = null;
  let attachmentMeta = [];
  let poll = null;
  try { envelope = JSON.parse(String(parsed.fields.envelope || 'null')); } catch {}
  try { attachmentMeta = JSON.parse(String(parsed.fields.attachmentMeta || '[]')); } catch {}
  try { poll = JSON.parse(String(parsed.fields.poll || 'null')); } catch {}
  return {
    body: parsed.fields.body,
    envelope,
    attachmentMeta: Array.isArray(attachmentMeta) ? attachmentMeta : [],
    files: parsed.files,
    replyToMessageId: parseReplyToId(parsed.fields.replyToMessageId),
    poll,
  };
}

function isPreviewable(mimeType) {
  return mimeType.startsWith('image/') && mimeType !== 'image/svg+xml';
}

function currentUser(request) {
  const token = requestSessionToken(request);
  if (!token) return null;
  const user = findUserBySession.get(hashSessionToken(token), new Date().toISOString());
  if (!user) return null;
  return { ...user, sessionHash: hashSessionToken(token) };
}

function createSession(response, userId) {
  const token = randomBase32(32);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + sessionLifetimeSeconds * 1_000).toISOString();
  insertSession.run(hashSessionToken(token), userId, expiresAt, now, null, null, null, randomBase32(12));
  response.setHeader('Set-Cookie', sessionCookie(token));
  return { accessToken: token, tokenType: 'Bearer', expiresAt };
}

function publicServerMember(item) {
  return {
    id: Number(item.id),
    username: item.username,
    verified: Number(item.is_verified) === 1,
    avatarUrl: item.avatar_url || null,
    bio: item.bio || '',
    nameStyle: publicNameStyle(item.name_style_json),
    customBadges: publicCustomBadges(item.custom_badges_json),
    isBot: Boolean(Number(item.is_bot)),
    roleId: Number(item.role_id),
    roleName: item.role_name,
    roleColor: item.role_color,
    permissions: item.permissions,
    permissionFlags: roleFlags(item),
    timeoutUntil: item.timeout_until && Date.parse(item.timeout_until) > Date.now() ? item.timeout_until : null,
    presence: Number(item.is_bot) ? 'online' : publicPresence(item.id),
  };
}

const PRESENCE_IDLE_MS = 5 * 60 * 1000;
const presenceByUser = new Map();

function presenceRecord(userId) {
  const id = Number(userId);
  let record = presenceByUser.get(id);
  if (!record) {
    const row = findUserById.get(id);
    record = {
      hidden: Boolean(Number(row?.presence_hidden) || Number(row?.keep_information_secret)),
      status: ['auto', 'online', 'idle', 'dnd', 'offline'].includes(row?.presence_status) ? row.presence_status : 'auto',
      lastActive: 0,
      published: 'offline',
    };
    presenceByUser.set(id, record);
  }
  return record;
}

function computePresence(userId) {
  const record = presenceRecord(userId);
  if (record.hidden) return 'offline';
  if (record.status !== 'auto') return record.status;
  if (!realtimeHub?.connectedCount?.(userId)) return 'offline';
  if (!record.lastActive || Date.now() - record.lastActive >= PRESENCE_IDLE_MS) return 'idle';
  return 'online';
}

function publicPresence(userId) {
  try {
    return computePresence(userId);
  } catch {
    return 'offline';
  }
}

function presenceAudience(userId, memberCache = null) {
  const ids = presenceDirectAudience(userId);
  for (const server of listServers.all(userId)) {
    let members = memberCache?.get(server.id);
    if (!members) {
      members = listServerMemberIds.all(server.id);
      memberCache?.set(server.id, members);
    }
    for (const member of members) ids.add(Number(member.user_id));
  }
  ids.delete(Number(userId));
  return ids;
}

function presenceDirectAudience(userId) {
  const ids = new Set();
  for (const friend of listFriends.all(userId, userId, userId)) ids.add(Number(friend.id));
  for (const peer of listConversationPeerIdsForUser.all(userId, userId)) ids.add(Number(peer.user_id));
  ids.delete(Number(userId));
  return ids;
}

function presencePayload(userId, viewerId = null) {
  const status = publicPresence(userId);
  const payload = { userId: Number(userId), status };
  if (viewerId != null && Number(viewerId) === Number(userId)) payload.hidden = presenceRecord(userId).hidden;
  return payload;
}

function broadcastPresence(userId) {
  const record = presenceRecord(userId);
  const status = publicPresence(userId);
  if (record.published === status && !record.force) return;
  record.published = status;
  record.force = false;
  loopService.presence.invalidate(userId);
  sendEvent(userId, 'presence', presencePayload(userId, userId));
  const payload = presencePayload(userId);
  presenceBatch.enqueue(userId, payload);
}

function syncPresenceFor(userId) {
  const users = [{ userId: Number(userId), status: publicPresence(userId), hidden: presenceRecord(userId).hidden, self: true }];
  // Server member status is already included in paginated server-member API pages.
  // Sync only direct contacts here so a large server does not send its entire roster
  // to every browser each time a socket connects or a tab becomes visible.
  for (const id of presenceDirectAudience(userId)) users.push({ userId: id, status: publicPresence(id) });
  sendEvent(userId, 'presence-sync', { users });
}

function markPresenceActive(userId) {
  const record = presenceRecord(userId);
  record.lastActive = Date.now();
  broadcastPresence(userId);
}

function setPresenceHidden(userId, hidden) {
  const record = presenceRecord(userId);
  updatePresenceHidden.run(hidden ? 1 : 0, userId);
  const row = findUserById.get(userId);
  record.hidden = Boolean(Number(row?.presence_hidden) || Number(row?.keep_information_secret));
  record.force = true;
  broadcastPresence(userId);
}

function setKeepInformationSecret(userId, enabled) {
  updateKeepInformationSecret.run(enabled ? 1 : 0, userId);
  const row = findUserById.get(userId);
  const record = presenceRecord(userId);
  record.hidden = Boolean(Number(row?.presence_hidden) || Number(row?.keep_information_secret));
  record.force = true;
  broadcastPresence(userId);
  sendEvent(userId, 'account-privacy-settings', { userId: Number(userId), keepInformationSecret: Boolean(enabled) });
}

function setPresenceStatus(userId, status) {
  const next = ['auto', 'online', 'idle', 'dnd', 'offline'].includes(status) ? status : null;
  if (!next) return false;
  const record = presenceRecord(userId);
  record.status = next;
  record.force = true;
  updatePresenceStatus.run(next, userId);
  broadcastPresence(userId);
  return true;
}

function publicChannel(row, unread = null) {
  const voice = Boolean(row.voice);
  const kind = publicChannelKind(row);
  return {
    id: Number(row.id),
    name: row.name,
    kind,
    voice,
    locked: voice ? false : channelIsStaffOnly(row),
    slowmode: voice ? 0 : Number(row.slowmode || 0),
    topic: voice ? '' : String(row.topic || ''),
    position: Number(row.position || 0),
    categoryId: row.category_id == null ? null : Number(row.category_id),
    messageCleanupIntervalSeconds: row.cleanup_interval_seconds == null ? 0 : Number(row.cleanup_interval_seconds),
    messageCleanupNextRunAt: row.cleanup_next_run_at || null,
    unreadCount: voice ? 0 : Number(unread?.unreadCount || 0),
    mentionCount: voice ? 0 : Number(unread?.mentionCount || 0),
    nuraActive: Boolean(Number(row.nura_active)),
  };
}

function mentionNamePattern(name) {
  return new RegExp(`(^|[^a-z0-9_])@${String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`, 'i');
}

function mentionedUserIdsFromBody(body, members) {
  const text = String(body || '');
  if (!text) return [];
  const ids = new Set();
  if (mentionNamePattern('everyone').test(text)) {
    for (const member of members) ids.add(Number(member.id));
    return [...ids];
  }
  for (const member of members) {
    if (member.username && mentionNamePattern(member.username).test(text)) ids.add(Number(member.id));
  }
  return [...ids];
}

function syncChannelMentions(messageId, channelId, body) {
  deleteChannelMentions.run(messageId);
  if (!String(body || '').includes('@')) return;
  const channelRecord = findChannel.get(channelId);
  if (!channelRecord || channelRecord.voice) return;
  const members = listServerMentionNames.all(channelRecord.server_id);
  for (const userId of mentionedUserIdsFromBody(body, members)) insertChannelMention.run(messageId, userId);
}

function homeUnread(userId) {
  const dmUnread = Number(countAllDmUnread.get(userId, userId)?.count || 0);
  const friendRequestCount = Number(countIncomingFriendRequests.get(userId)?.count || 0);
  return { dmUnread, friendRequestCount, homeUnread: dmUnread + friendRequestCount };
}

function conversationUnreadCount(conversationId, userId) {
  return Number(countConversationUnread.get(conversationId, userId, conversationId, userId)?.count || 0);
}

function channelUnreadMap(userId) {
  const channels = new Map();
  const servers = new Map();
  for (const row of listChannelUnreads.all(userId, userId, userId, userId, userId)) {
    const unreadCount = Number(row.unread_count || 0);
    const mentionCount = Number(row.mention_count || 0);
    const channelId = Number(row.channel_id);
    const serverId = Number(row.server_id);
    if (findServerMute.get(userId, serverId)) continue;
    channels.set(channelId, { unreadCount, mentionCount });
    const current = servers.get(serverId) || { unread: false, unreadCount: 0, mentionCount: 0 };
    current.unread = current.unread || unreadCount > 0;
    current.unreadCount += unreadCount;
    current.mentionCount += mentionCount;
    servers.set(serverId, current);
  }
  return { channels, servers };
}

function channelUnreadMapForServer(userId, serverId) {
  const channels = new Map();
  if (findServerMute.get(userId, Number(serverId))) return channels;
  for (const row of listChannelUnreadsForServer.all(userId, userId, userId, userId, serverId)) {
    channels.set(Number(row.channel_id), {
      unreadCount: Number(row.unread_count || 0),
      mentionCount: Number(row.mention_count || 0),
    });
  }
  return channels;
}

function serverUnreadSummaryForUser(userId, serverId, sharedCounts) {
  let channels;
  if (sharedCounts) {
    channels = new Map();
    if (!findServerMute.get(userId, Number(serverId))) {
      for (const row of listUnreadReadPositions.all(userId, serverId)) {
        const key = `${row.id}:${row.last_read}`;
        let total = sharedCounts.get(key);
        if (total === undefined) {
          total = Number(countLiveAfter.get(row.id, row.last_read).n);
          if (sharedCounts.size < 8192) sharedCounts.set(key, total);
        }
        channels.set(Number(row.id), {
          unreadCount: total - Number(countOwnLiveAfter.get(row.id, userId, row.last_read).n),
          mentionCount: Number(countMentionLiveAfter.get(userId, row.id, row.last_read, userId).n),
        });
      }
    }
  } else channels = channelUnreadMapForServer(userId, serverId);
  const summary = { unread: false, unreadCount: 0, mentionCount: 0 };
  for (const unread of channels.values()) {
    summary.unread = summary.unread || unread.unreadCount > 0;
    summary.unreadCount += unread.unreadCount;
    summary.mentionCount += unread.mentionCount;
  }
  return { channels, summary };
}

function serverRailUnreadMap(userId) {
  return channelUnreadMap(userId).servers;
}

function unreadStateFor(userId, extra = {}) {
  return { ...homeUnread(userId), ...extra };
}

function initChannelReadsForMember(serverId, userId) {
  for (const channel of listServerChannels.all(serverId)) {
    if (channel.voice) continue;
    upsertChannelRead.run(channel.id, userId, Number(maxChannelMessageId.get(channel.id)?.id || 0));
  }
}

function applyConversationRead(conversationId, userId, messageId) {
  if (!isConversationMember.get(conversationId, userId)) return false;
  const maxId = Number(maxConversationMessageId.get(conversationId)?.id || 0);
  const requested = Number(messageId);
  const target = Number.isInteger(requested) && requested > 0 ? Math.min(requested, maxId) : maxId;
  if (!target) return true;
  markConversationRead.run(target, target, conversationId, userId);
  sendEvent(userId, 'unread', unreadStateFor(userId, { kind: 'dm', conversationId, unreadCount: conversationUnreadCount(conversationId, userId) }));
  return true;
}

function applyChannelRead(channelId, userId, messageId) {
  if (!isChannelMember.get(channelId, userId)) return false;
  const channelRecord = findChannel.get(channelId);
  if (!channelRecord || channelRecord.voice) return false;
  const maxId = Number(maxChannelMessageId.get(channelId)?.id || 0);
  const requested = Number(messageId);
  const target = Number.isInteger(requested) && requested > 0 ? Math.min(requested, maxId) : maxId;
  if (target) upsertChannelRead.run(channelId, userId, target);
  const map = channelUnreadMap(userId);
  const channel = map.channels.get(Number(channelId)) || { unreadCount: 0, mentionCount: 0 };
  const server = map.servers.get(Number(channelRecord.server_id)) || { unread: false, unreadCount: 0, mentionCount: 0 };
  sendEvent(userId, 'unread', unreadStateFor(userId, {
    kind: 'channel',
    serverId: Number(channelRecord.server_id),
    channelId: Number(channelId),
    unreadCount: channel.unreadCount,
    mentionCount: channel.mentionCount,
    serverUnread: server.unread,
    serverUnreadCount: server.unreadCount,
    serverMentionCount: server.mentionCount,
  }));
  return true;
}

const channelMessageFanout = createMessageFanoutQueue(deliverChannelMessageBatch, { onError(error) {
  console.error('Channel message fanout failed:', error.message);
  realtimeHub.closeAll(1011, 'Message sync failed; reconnect');
  for (const clients of eventClients.values()) for (const client of clients) client.end();
} });

function notifyChannelMessageCreated(serverId, payload, senderId) {
  channelMessageFanout.enqueue(Number(serverId), { prepared: realtimeHub.prepareEvent('channel-message', payload), payload, senderId });
}

function deliverChannelMessageBatch(serverId, items) {
  const seen = new Set();
  // Counts are shared only within this synchronous flush, never across writes or reads.
  const sharedCounts = new Map();
  for (const member of listServerMemberIds.all(serverId)) {
    const userId = Number(member.user_id);
    seen.add(userId);
    if (!hasLiveEventClient(userId)) continue;
    const { channels, summary } = serverUnreadSummaryForUser(userId, serverId, sharedCounts);
    for (const { prepared, payload, senderId } of items) {
      const isSender = userId === Number(senderId);
      const channel = channels.get(Number(payload.channelId)) || { unreadCount: 0, mentionCount: 0 };
      sendPreparedEvent(userId, prepared, {
        unreadCount: isSender ? 0 : channel.unreadCount,
        mentionCount: isSender ? 0 : channel.mentionCount,
        serverUnread: summary.unread,
        serverUnreadCount: summary.unreadCount,
        serverMentionCount: summary.mentionCount,
        mentioned: !isSender && channel.mentionCount > 0,
      });
    }
  }
  for (const userId of listPlatformAdminIds()) {
    if (seen.has(userId) || !hasLiveEventClient(userId)) continue;
    for (const { prepared } of items) sendPreparedEvent(userId, prepared, {
      unreadCount: 0,
      mentionCount: 0,
      serverUnread: false,
      serverUnreadCount: 0,
      serverMentionCount: 0,
      mentioned: false,
    });
  }
}

function emitFriends(userId, type) {
  sendEvent(userId, 'friends', unreadStateFor(userId, { type }));
}

function notifyDirectMessage(conversationId, message, senderId, action = 'created') {
  const prepared = realtimeHub.prepareEvent('message', {
    conversationId,
    action,
    message: action === 'deleted' ? { id: Number(message.id) } : message,
  });
  for (const member of listConversationMemberIds.all(conversationId)) {
    const userId = Number(member.user_id);
    if (!hasLiveEventClient(userId)) continue;
    const hiddenReply = message.replyTo && message.replyTo.id <= groupDms.historyStart(conversationId, userId);
    sendPreparedEvent(userId, prepared, unreadStateFor(userId, {
      ...(hiddenReply ? { message: { ...message, replyTo: { id: message.replyTo.id, body: '', deleted: true } } } : {}),
      unreadCount: userId === Number(senderId) ? 0 : conversationUnreadCount(conversationId, userId),
    }));
  }
}

const eventClients = new Map();
const voiceRooms = new Map();
const voiceJoinSockets = new Map();
const dmCalls = new Map();
const dmCallByUser = new Map();
const dmCallSockets = new Map();
const DM_CALL_RING_MS = 45_000;

function sendEvent(userId, event, payload) {
  realtimeHub.send(Number(userId), event, payload);
  const clients = eventClients.get(Number(userId));
  if (!clients) return;
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(message);
}

function sendPreparedEvent(userId, prepared, extra) {
  realtimeHub.sendPrepared(userId, prepared, extra);
  const clients = eventClients.get(Number(userId));
  if (!clients?.size) return;
  const message = `event: ${prepared.event}\ndata: ${JSON.stringify({ ...prepared.payload, ...extra })}\n\n`;
  for (const client of clients) client.write(message);
}

function hasLiveEventClient(userId) {
  const id = Number(userId);
  return realtimeHub.connectedCount(id) > 0 || Boolean(eventClients.get(id)?.size);
}

function broadcastEvent(userIds, event, payload) {
  const ids = new Set([...userIds]
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0 && hasLiveEventClient(id)));
  if (!ids.size) return;
  realtimeHub.broadcast(ids, event, payload);
  let message;
  for (const userId of ids) {
    const clients = eventClients.get(userId);
    if (!clients) continue;
    message ??= `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) client.write(message);
  }
}

const notificationPreferences = createNotificationPreferences({ database, requireUser: requireSignedInUser, readJson, sendJson, sendEvent,
  onConversationMute: (userId, conversationId) => sendEvent(userId, 'unread', unreadStateFor(userId, { kind: 'dm', conversationId, unreadCount: conversationUnreadCount(conversationId, userId) })),
  channelVisible: (userId, channelId) => { const user = findUserById.get(userId); return Boolean(user && canSeeChannel(user, channelId)); } });
const pushService = createPushService({ database, dataDirectory, canNotify: notificationPreferences.canNotify });
createScheduledNotifications({ database, pushService }).start();

function previewText(value, fallback) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function pushConversationMembers(conversationId, payload, exceptUserId) {
  pushService.notifyUsers(listConversationMemberIds.all(conversationId).map((row) => row.user_id), payload, exceptUserId);
}

const listServerPushRecipients = database.prepare('SELECT DISTINCT m.user_id FROM server_members m JOIN push_subscriptions p ON p.user_id = m.user_id LEFT JOIN user_server_mutes mute ON mute.user_id = m.user_id AND mute.server_id = m.server_id WHERE m.server_id = ? AND mute.user_id IS NULL');
function pushServerMembers(serverId, payload, exceptUserId) {
  pushService.notifyUsers(listServerPushRecipients.all(serverId).map((row) => row.user_id), payload, exceptUserId);
}

function publicVoiceMember(member) {
  return {
    id: Number(member.id),
    username: member.username,
    avatarUrl: member.avatarUrl || null,
    muted: Boolean(member.muted),
    deafened: Boolean(member.deafened),
    camera: Boolean(member.camera),
    sharing: Boolean(member.sharing),
    speaking: Boolean(member.speaking),
  };
}

function occupancyForServer(serverId) {
  const channels = {};
  const sid = Number(serverId);
  for (const [key, room] of voiceRooms.entries()) {
    const [roomServerId, roomChannelId] = key.split(':');
    if (Number(roomServerId) !== sid) continue;
    channels[String(roomChannelId)] = [...room.values()].map(publicVoiceMember);
  }
  return { serverId: sid, channels };
}

function notifyVoiceOccupancy(serverId) {
  notifyServerMembers(serverId, 'voice-occupancy', occupancyForServer(serverId));
}

function publishVoiceRoom(key, action, participant) {
  const room = voiceRooms.get(key);
  const [serverId, channelId] = key.split(':').map(Number);
  const participants = room ? [...room.values()].map(publicVoiceMember) : [];
  const audience = room ? participants : [];
  const targets = action === 'left' && !room ? [participant] : audience;
  for (const member of targets) sendEvent(member.id, 'voice-presence', { serverId, channelId, action, participant, participants });
  notifyVoiceOccupancy(serverId);
}

function emptyVoiceRoom(key) {
  const room = voiceRooms.get(key);
  if (!room) return;
  voiceRooms.delete(key);
  appService.closeScope(`c:${key}`);
  const [serverId, channelId] = key.split(':').map(Number);
  for (const participant of room.values()) {
    voiceJoinSockets.delete(participant.id);
    sendEvent(participant.id, 'voice-presence', { serverId, channelId, action: 'left', participant: { id: participant.id }, participants: [] });
  }
  notifyVoiceOccupancy(serverId);
}

function leaveVoiceRooms(userId, exceptKey = null, serverIdFilter = null) {
  const id = Number(userId);
  if (!exceptKey && serverIdFilter === null) voiceJoinSockets.delete(id);
  const leftChannels = [];
  for (const [key, room] of [...voiceRooms.entries()]) {
    if (key === exceptKey || !room.has(id)) continue;
    const [roomServerId, channelId] = key.split(':').map(Number);
    if (serverIdFilter !== null && roomServerId !== Number(serverIdFilter)) continue;
    room.delete(id);
    if (!room.size) {
      voiceRooms.delete(key);
      appService.closeScope(`c:${key}`);
    }
    appService.dropScopeMember(id, `c:${key}`);
    publishVoiceRoom(key, 'left', { id });
    leftChannels.push(channelId);
  }
  if (!exceptKey && leftChannels.length) voiceJoinSockets.delete(id);
  return leftChannels;
}

function publicCallUser(userId) {
  const row = findUserById.get(Number(userId));
  if (!row) return { id: Number(userId), username: 'Unknown', avatarUrl: null, nameStyle: null };
  return {
    id: Number(row.id),
    username: row.username,
    verified: Number(row.is_verified) === 1,
    avatarUrl: row.avatar_url || null,
    nameStyle: publicNameStyle(row.name_style_json),
    customBadges: publicCustomBadges(row.custom_badges_json),
  };
}

function conversationPeerId(conversationId, userId) {
  const other = listConversationMemberIds.all(conversationId).find((row) => Number(row.user_id) !== Number(userId));
  return other ? Number(other.user_id) : null;
}

function endDmCall(conversationId, reason) {
  const id = Number(conversationId);
  const call = dmCalls.get(id);
  if (!call) return;
  appService.closeScope(`d:${id}`);
  if (call.timeout) clearTimeout(call.timeout);
  dmCalls.delete(id);
  dmCallByUser.delete(call.callerId);
  dmCallByUser.delete(call.calleeId);
  dmCallSockets.delete(call.callerId);
  dmCallSockets.delete(call.calleeId);
  const payload = { conversationId: id, reason, callerId: call.callerId, calleeId: call.calleeId };
  sendEvent(call.callerId, 'dm-call-ended', payload);
  sendEvent(call.calleeId, 'dm-call-ended', payload);
}

function leaveDmCalls(userId, reason = 'hangup') {
  const conversationId = dmCallByUser.get(Number(userId));
  if (conversationId) endDmCall(conversationId, reason);
}

function bindDmCallSocket(userId, conversationId, socket) {
  dmCallSockets.set(Number(userId), { conversationId: Number(conversationId), socket });
}

function handleDmCallEvent(user, message, socket) {
  const payload = message.payload || {};
  const conversationId = Number(payload.conversationId);
  if (!Number.isInteger(conversationId) || conversationId <= 0) return;
  if (!isConversationMember.get(conversationId, user.id)) {
    sendEvent(user.id, 'dm-call-error', { conversationId, error: 'Conversation not found.' });
    return;
  }
  const peerId = conversationPeerId(conversationId, user.id);
  if (groupDms.isGroup(conversationId)) {
    sendEvent(user.id, 'dm-call-error', { conversationId, error: 'Voice calls are available in one-to-one DMs only.' });
    return;
  }
  if (!peerId || peerId === Number(user.id)) {
    sendEvent(user.id, 'dm-call-error', { conversationId, error: 'You can only call one person in a DM.' });
    return;
  }
  if (isBlockedEither(user.id, peerId)) {
    sendEvent(user.id, 'dm-call-error', { conversationId, error: "You can't call this person." });
    return;
  }
  const existing = dmCalls.get(conversationId);
  const mine = dmCallByUser.get(Number(user.id));
  let eventName = message.event;

  if (eventName === 'dm-call-invite') {
    if (mine && mine !== conversationId) {
      sendEvent(user.id, 'dm-call-error', { conversationId, error: 'Already in a call.' });
      return;
    }
    const peerBusy = dmCallByUser.get(peerId);
    if (peerBusy && peerBusy !== conversationId) {
      sendEvent(user.id, 'dm-call-error', { conversationId, error: 'They are already in a call.' });
      return;
    }
    if (existing?.state === 'active') {
      sendEvent(user.id, 'dm-call-error', { conversationId, error: 'That call is already active.' });
      return;
    }
    if (existing?.state === 'ringing' && existing.calleeId === Number(user.id)) {
      eventName = 'dm-call-accept';
    } else if (existing?.state === 'ringing' && existing.callerId === Number(user.id)) {
      if (existing.timeout) clearTimeout(existing.timeout);
      existing.timeout = setTimeout(() => endDmCall(conversationId, 'timeout'), DM_CALL_RING_MS);
      existing.timeout.unref?.();
      bindDmCallSocket(user.id, conversationId, socket);
      sendEvent(peerId, 'dm-call-invite', { conversationId, role: 'callee', video: Boolean(existing.video), peer: publicCallUser(user.id) });
      sendEvent(user.id, 'dm-call-invite', { conversationId, role: 'caller', video: Boolean(existing.video), peer: publicCallUser(peerId) });
      return;
    } else if (existing) {
      sendEvent(user.id, 'dm-call-error', { conversationId, error: 'That call is already ringing.' });
      return;
    } else {
      leaveVoiceRooms(user.id);
      const video = payload.video === true;
      const call = {
        conversationId,
        callerId: Number(user.id),
        calleeId: peerId,
        state: 'ringing',
        video,
        timeout: setTimeout(() => endDmCall(conversationId, 'timeout'), DM_CALL_RING_MS),
      };
      call.timeout.unref?.();
      dmCalls.set(conversationId, call);
      dmCallByUser.set(Number(user.id), conversationId);
      dmCallByUser.set(peerId, conversationId);
      bindDmCallSocket(user.id, conversationId, socket);
      sendEvent(user.id, 'dm-call-invite', { conversationId, role: 'caller', video, peer: publicCallUser(peerId) });
      sendEvent(peerId, 'dm-call-invite', { conversationId, role: 'callee', video, peer: publicCallUser(user.id) });
      pushService.notifyUsers([peerId], {
        kind: 'dm-call',
        title: `${user.username} is calling`,
        body: 'Incoming call',
        url: '/dms',
        conversationId,
        tag: `dm-call-${conversationId}`,
      }, user.id);
      return;
    }
  }

  if (eventName === 'dm-call-accept') {
    if (!existing || existing.state !== 'ringing' || existing.calleeId !== Number(user.id)) {
      sendEvent(user.id, 'dm-call-error', { conversationId, error: 'That call is no longer ringing.' });
      return;
    }
    leaveVoiceRooms(user.id);
    if (existing.timeout) clearTimeout(existing.timeout);
    existing.timeout = null;
    existing.state = 'active';
    bindDmCallSocket(user.id, conversationId, socket);
    sendEvent(existing.callerId, 'dm-call-accepted', { conversationId, role: 'caller', peer: publicCallUser(user.id) });
    sendEvent(existing.calleeId, 'dm-call-accepted', { conversationId, role: 'callee', peer: publicCallUser(existing.callerId) });
    return;
  }

  if (eventName === 'dm-call-decline') {
    if (!existing || existing.calleeId !== Number(user.id)) return;
    endDmCall(conversationId, 'declined');
    return;
  }

  if (eventName === 'dm-call-hangup') {
    if (!existing) return;
    if (existing.callerId !== Number(user.id) && existing.calleeId !== Number(user.id)) return;
    endDmCall(conversationId, 'hangup');
    return;
  }

  if (eventName === 'dm-call-signal') {
    if (!existing || existing.state !== 'active') return;
    if (existing.callerId !== Number(user.id) && existing.calleeId !== Number(user.id)) return;
    let encoded = '';
    try { encoded = JSON.stringify(payload.signal || null); } catch { return; }
    if (!encoded || encoded.length > 48_000) return;
    if (!payload.signal || typeof payload.signal !== 'object') return;
    const targetId = existing.callerId === Number(user.id) ? existing.calleeId : existing.callerId;
    sendEvent(targetId, 'dm-call-signal', { conversationId, fromId: Number(user.id), signal: payload.signal });
  }
}

function closeVoiceRoomsForServer(serverId) {
  const sid = Number(serverId);
  for (const key of [...voiceRooms.keys()]) {
    const [roomServerId] = key.split(':');
    if (Number(roomServerId) === sid) emptyVoiceRoom(key);
  }
}

const voiceStateHits = new Map();

function allowVoiceState(userId) {
  const now = Date.now();
  const hits = (voiceStateHits.get(userId) || []).filter((stamp) => now - stamp < 1000);
  if (hits.length >= 8) return false;
  hits.push(now);
  voiceStateHits.set(userId, hits);
  return true;
}

function appScopeFromKey(key) {
  const text = String(key || '');
  const channelMatch = text.match(/^c:(\d+):(\d+)$/);
  if (channelMatch) {
    const serverId = Number(channelMatch[1]);
    const channelId = Number(channelMatch[2]);
    const channelRecord = findChannel.get(channelId);
    if (!channelRecord || Number(channelRecord.server_id) !== serverId || !channelRecord.voice) return null;
    return { key: text, kind: 'channel', serverId, channelId };
  }
  const dmMatch = text.match(/^d:(\d+)$/);
  if (dmMatch) return { key: text, kind: 'dm', conversationId: Number(dmMatch[1]) };
  return null;
}

function appResolveScope(user, payload) {
  if (payload.scopeKey) return appScopeFromKey(payload.scopeKey) || { error: 'That app space is unavailable.' };
  if (payload.conversationId != null) {
    const conversationId = Number(payload.conversationId);
    if (!Number.isInteger(conversationId) || conversationId <= 0) return { error: 'That app space is unavailable.' };
    return { key: `d:${conversationId}`, kind: 'dm', conversationId };
  }
  const serverId = Number(payload.serverId);
  const channelId = Number(payload.channelId);
  if (!Number.isInteger(serverId) || !Number.isInteger(channelId)) return { error: 'That app space is unavailable.' };
  return appScopeFromKey(`c:${serverId}:${channelId}`) || { error: 'That app space is unavailable.' };
}

async function readSingleUpload(request, field) {
  const formRequest = new Request(`http://${request.headers.host || 'localhost'}${request.url}`, {
    method: request.method,
    headers: request.headers,
    body: Readable.toWeb(request),
    duplex: 'half',
  });
  const form = await formRequest.formData();
  const file = form.get(field);
  if (!file || typeof file.arrayBuffer !== 'function') return null;
  return { type: file.type, bytes: Buffer.from(await file.arrayBuffer()), scopeKey: String(form.get('scopeKey') || '') };
}

const appService = createAppService({
  database,
  uploadDirectory,
  apiPrefix,
  sendEvent,
  randomId: randomBase32,
  hooks: {
    resolveScope: appResolveScope,
    scopeFromKey: appScopeFromKey,
    canUseScope(userId, scope) {
      if (scope.kind === 'channel') return Boolean(voiceRooms.get(`${scope.serverId}:${scope.channelId}`)?.has(Number(userId)));
      const call = dmCalls.get(Number(scope.conversationId));
      return Boolean(call && call.state === 'active' && (call.callerId === Number(userId) || call.calleeId === Number(userId)));
    },
    canSeeScope(userId, scope) {
      if (scope.kind === 'channel') return Boolean(isChannelMember.get(scope.channelId, userId));
      return Boolean(isConversationMember.get(scope.conversationId, userId));
    },
    canModerateScope(user, scope) {
      return scope.kind === 'channel' ? canServerPermission(user, scope.serverId, 'manageApps') : false;
    },
    scopeAudienceIds(scope) {
      const rows = scope.kind === 'channel'
        ? listServerMemberIds.all(scope.serverId)
        : listConversationMemberIds.all(scope.conversationId);
      return rows.map((row) => Number(row.user_id));
    },
    publicUser: publicCallUser,
    sendFile(request, response, filePath, type) {
      return sendLocalFile(request, response, filePath, {
        type: sanitizeMimeType(type) || 'application/octet-stream',
        extra: { 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' },
      });
    },
  },
});

const realtimeHub = createRealtimeHub({
  authenticate(request) {
    const user = currentUser(request);
    return user && findAgreementAcceptance.get(Number(user.id), TERMS_VERSION, CONDUCT_VERSION) ? user : null;
  },
  onConnect(user) {
    markPresenceActive(user.id);
    syncPresenceFor(user.id);
  },
  onDisconnect(user, socket) {
    loopService.presence.leave(socket);
    appService.handleDisconnect(user, socket);
    if (voiceJoinSockets.get(Number(user.id)) === socket) {
      voiceJoinSockets.delete(Number(user.id));
      leaveVoiceRooms(user.id);
    }
    const owned = dmCallSockets.get(Number(user.id));
    if (owned?.socket === socket) {
      dmCallSockets.delete(Number(user.id));
      const call = dmCalls.get(owned.conversationId);
      if (call && (call.state === 'active' || call.callerId === Number(user.id))) endDmCall(owned.conversationId, 'disconnect');
    }
    setTimeout(() => broadcastPresence(user.id), 0);
  },
  onClientEvent(user, message, _reply, socket) {
    const restriction = messageReports?.getRestriction(user.id);
    if (restriction && !['voice-leave', 'dm-call-hangup'].includes(message?.event)) {
      _reply('account-restricted', restriction);
      return;
    }
    if (loopRoutesEnabled && loopService.presence.handle(user, message, socket)) return;
    if (String(message?.event || '').startsWith('app-')) {
      appService.handleClientEvent(user, message, socket);
      return;
    }
    if (['voice-join', 'voice-leave', 'voice-signal', 'voice-state'].includes(message?.event)) {
      const payload = message.payload || {};
      const serverId = Number(payload.serverId);
      const channelId = Number(payload.channelId);
      if (!Number.isInteger(serverId) || !Number.isInteger(channelId) || !isServerMember.get(serverId, user.id)) return;
      const channelRecord = findChannel.get(channelId);
      if (!channelRecord || Number(channelRecord.server_id) !== serverId || !channelRecord.voice) return;
      const key = `${serverId}:${channelId}`;
      const room = voiceRooms.get(key) || new Map();
      if (message.event === 'voice-join') {
        if (room.size >= 12 && !room.has(Number(user.id))) {
          sendEvent(user.id, 'voice-error', { serverId, channelId, error: 'This voice channel is full.' });
          return;
        }
        leaveDmCalls(user.id, 'voice');
        leaveVoiceRooms(user.id, key);
        const previous = room.get(Number(user.id));
        room.set(Number(user.id), {
          id: Number(user.id),
          username: user.username,
          avatarUrl: user.avatar_url || null,
          muted: Boolean(previous?.muted),
          deafened: Boolean(previous?.deafened),
          camera: Boolean(previous?.camera),
          sharing: Boolean(previous?.sharing),
          speaking: Boolean(previous?.speaking),
        });
        voiceRooms.set(key, room);
        voiceJoinSockets.set(Number(user.id), socket);
        publishVoiceRoom(key, 'joined', publicVoiceMember(room.get(Number(user.id))));
      } else if (message.event === 'voice-leave') {
        if (voiceJoinSockets.get(Number(user.id)) === socket) voiceJoinSockets.delete(Number(user.id));
        room.delete(Number(user.id));
        if (!room.size) voiceRooms.delete(key);
        appService.dropScopeMember(user.id, `c:${key}`);
        publishVoiceRoom(key, 'left', { id: Number(user.id) });
      } else if (message.event === 'voice-state') {
        if (!allowVoiceState(Number(user.id)) || !room.has(Number(user.id))) return;
        const member = room.get(Number(user.id));
        for (const flag of ['muted', 'deafened', 'camera', 'sharing', 'speaking']) {
          if (typeof payload[flag] === 'boolean') member[flag] = payload[flag];
        }
        if (member.deafened) member.muted = true;
        if (member.muted) member.speaking = false;
        notifyServerMembers(serverId, 'voice-state', { serverId, channelId, userId: Number(user.id), ...publicVoiceMember(member) });
      } else {
        const targetId = Number(payload.targetId);
        let encoded = '';
        try { encoded = JSON.stringify(payload.signal || null); } catch { return; }
        if (!encoded || encoded.length > 48_000) return;
        if (room.has(Number(user.id)) && room.has(targetId) && payload.signal && targetId !== Number(user.id)) {
          sendEvent(targetId, 'voice-signal', { serverId, channelId, fromId: Number(user.id), signal: payload.signal });
        }
      }
      return;
    }
    if (String(message?.event || '').startsWith('dm-call-')) {
      handleDmCallEvent(user, message, socket);
      return;
    }
    if (message?.event === 'presence-sync-request') {
      syncPresenceFor(user.id);
      return;
    }
    if (message?.event === 'presence') {
      if (message.payload?.active === true) markPresenceActive(user.id);
      return;
    }
    if (message?.event === 'channel-typing') {
      if (Boolean(Number(findKeepInformationSecret.get(user.id)?.keep_information_secret))) return;
      const channelId = Number(message?.payload?.channelId);
      const channelRecord = findChannel.get(channelId);
      if (!channelRecord || channelRecord.voice || !isChannelMember.get(channelId, user.id)) return;
      const audience = listServerMemberIds.all(channelRecord.server_id).map(member => Number(member.user_id)).filter(id => id !== Number(user.id));
      broadcastEvent(audience, 'channel-typing', { serverId: Number(channelRecord.server_id), channelId, userId: Number(user.id), username: user.username, typing: message?.payload?.typing === true });
      return;
    }
    if (message?.event !== 'typing') return;
    if (Boolean(Number(findKeepInformationSecret.get(user.id)?.keep_information_secret))) return;
    const conversationId = Number(message?.payload?.conversationId);
    if (!Number.isInteger(conversationId) || !isConversationMember.get(conversationId, user.id)) return;
    for (const member of listConversationMemberIds.all(conversationId)) {
      if (Number(member.user_id) !== Number(user.id)) sendEvent(member.user_id, 'typing', { conversationId, userId: Number(user.id), username: user.username, typing: message?.payload?.typing === true });
    }
  },
});

const presenceBatch = createPresenceBatch({
  audienceFor: presenceAudience,
  isConnected: hasLiveEventClient,
  send: sendEvent,
});

const videoDownloadService = createVideoDownloadService({ dataDirectory, sendJson, readJson, requireSignedInUser, sendLocalFile, takeRateLimit });
const loopService = createLoopService({
  database,
  pushService,
  uploadDirectory,
  parseMultipart,
  sendLocalFile,
  sendJson,
  readJson,
  currentUser,
  realtimeHub,
  isAdmin: isPlatformAdmin,
  publicPresence,
  nameFile: () => `loop-${randomBase32(24)}`,
  copyVideoDownload: (userId,id,storageName) => videoDownloadService.copyToPost(userId,id,uploadDirectory,storageName),
});

setInterval(() => {
  for (const [userId, record] of presenceByUser) {
    if (record.published === 'offline' && !realtimeHub.connectedCount(userId)) continue;
    broadcastPresence(userId);
  }
}, 15_000).unref?.();

function notifyServerMembers(serverId, event, payload) {
  // A later edit/delete/clear must never overtake queued message creation.
  channelMessageFanout.flush();
  const recipients = new Set(listServerMemberIds.all(serverId).map((member) => Number(member.user_id)));
  for (const userId of listPlatformAdminIds()) recipients.add(Number(userId));
  broadcastEvent(recipients, event, payload);
}

function permanentlyClearChannelMessages(channelId) {
  const storageNames = listChannelCleanupUploads.all(channelId).map((row) => row.storage_name);
  let result;
  withTransaction(() => { result = deleteAllChannelMessages.run(channelId); });
  removeStoredUploads(storageNames);
  return { deletedCount: result.changes, attachmentCount: storageNames.length };
}

function runDueChannelMessageCleanup() {
  const now = new Date();
  for (const schedule of dueChannelMessageCleanup.all(now.toISOString())) {
    try {
      const counts = permanentlyClearChannelMessages(Number(schedule.channel_id));
      const cleanedChannel = findChannel.get(Number(schedule.channel_id));
      writeServerAudit(Number(schedule.server_id), { username: 'System' }, 'channel.messages-cleared-scheduled', { targetType: 'channel', targetId: schedule.channel_id, targetName: cleanedChannel?.name || '', details: { deletedCount: counts.deletedCount, intervalSeconds: Number(schedule.interval_seconds) } });
      const nextRunAt = new Date(now.getTime() + Number(schedule.interval_seconds) * 1000).toISOString();
      updateChannelCleanupNextRun.run(nextRunAt, now.toISOString(), Number(schedule.channel_id));
      notifyServerMembers(Number(schedule.server_id), 'channel-messages-cleared', {
        serverId: Number(schedule.server_id),
        channelId: Number(schedule.channel_id),
        deletedCount: counts.deletedCount,
        scheduled: true,
      });
      notifyServerMembers(Number(schedule.server_id), 'server-updated', { serverId: Number(schedule.server_id), action: 'channel-messages-cleared', channelId: Number(schedule.channel_id) });
    } catch (error) {
      console.error('Scheduled channel cleanup failed:', error);
    }
  }
}

setInterval(runDueChannelMessageCleanup, 30_000).unref?.();
runDueChannelMessageCleanup();

function parseStoredPoll(value) {
  const parsed = typeof value === 'string' ? safeJsonParse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const question = String(parsed.question || '').trim();
  const options = Array.isArray(parsed.options) ? parsed.options.map((item) => String(item || '').trim()) : [];
  if (!question || options.length < 2 || options.length > 10 || options.some((item) => !item)) return null;
  return {
    question: question.slice(0, 300),
    options: options.map((item) => item.slice(0, 100)),
    allowMultiple: Boolean(parsed.allowMultiple),
    closed: Boolean(parsed.closed),
    closedAt: parsed.closedAt || null,
  };
}

function sanitizePoll(input) {
  if (input == null) return { poll: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'Invalid poll.' };
  const question = String(input.question || '').trim();
  if (question.length < 1 || question.length > 300) return { error: 'Poll question must be 1–300 characters.' };
  const raw = Array.isArray(input.options) ? input.options : [];
  const options = [];
  for (const item of raw) {
    const text = String(item || '').trim();
    if (!text) continue;
    if (text.length > 100) return { error: 'Poll options must be 1–100 characters.' };
    options.push(text);
  }
  if (options.length < 2 || options.length > 10) return { error: 'Polls need 2–10 options.' };
  return {
    poll: {
      question,
      options,
      allowMultiple: Boolean(input.allowMultiple),
      closed: false,
      closedAt: null,
    },
  };
}

function moderationText(body, poll) {
  const pollText = poll ? [poll.question, ...poll.options].join('\n') : '';
  return [String(body || '').trim(), pollText].filter(Boolean).join('\n');
}

function moderationContext(channelId, beforeMessageId = Number.MAX_SAFE_INTEGER) {
  return listModerationContext.all(channelId, beforeMessageId, '').reverse().map((item) => String(item.body).slice(0, 2000));
}

function auditModerationResult(channelRecord, actor, action, details = {}, targetId = channelRecord.id, targetType = 'channel') {
  writeServerAudit(channelRecord.server_id, actor, `message.moderation-${action}`, {
    targetType,
    targetId,
    targetName: channelRecord.name,
    details: { severity: details.severity, categories: details.categories, provider: details.provider },
  });
}

function publicPoll(stored, votes = [], viewerId) {
  const poll = parseStoredPoll(stored);
  if (!poll) return null;
  const counts = Array(poll.options.length).fill(0);
  const myVotes = [];
  const voters = new Set();
  for (const vote of votes) {
    const index = Number(vote.option_index);
    if (!Number.isInteger(index) || index < 0 || index >= poll.options.length) continue;
    counts[index] += 1;
    voters.add(Number(vote.user_id));
    if (Number(vote.user_id) === Number(viewerId)) myVotes.push(index);
  }
  return {
    question: poll.question,
    options: poll.options.map((text, index) => ({
      index,
      text,
      votes: counts[index],
      voted: myVotes.includes(index),
    })),
    allowMultiple: poll.allowMultiple,
    closed: poll.closed,
    voterCount: voters.size,
  };
}

function notifyChannelPoll(serverId, channelId, messageId) {
  const seen = new Set();
  for (const member of listServerMemberIds.all(serverId)) {
    const userId = Number(member.user_id);
    seen.add(userId);
    if (!hasLiveEventClient(userId)) continue;
    sendEvent(userId, 'channel-message', {
      serverId: Number(serverId),
      channelId: Number(channelId),
      action: 'poll',
      message: channelMessageFullPayload(channelId, messageId, userId),
    });
  }
  for (const userId of listPlatformAdminIds()) {
    if (seen.has(userId) || !hasLiveEventClient(userId)) continue;
    sendEvent(userId, 'channel-message', {
      serverId: Number(serverId),
      channelId: Number(channelId),
      action: 'poll',
      message: channelMessageFullPayload(channelId, messageId, userId),
    });
  }
}

function channelReplySnippet(message) {
  if (!message.reply_to_message_id) return null;
  const deleted = Boolean(message.reply_deleted_at) || !message.reply_id;
  const poll = deleted ? null : parseStoredPoll(message.reply_poll_json);
  const body = deleted ? '' : String(message.reply_body || '').trim() || poll?.question || '';
  return {
    id: Number(message.reply_to_message_id),
    username: message.reply_username || 'Unknown',
    deleted,
    body,
  };
}

function channelMessagePayload(message, reactions = [], attachments = [], votes = [], viewerId = null) {
  return {
    id: Number(message.id),
    channelId: Number(message.channel_id),
    body: message.body,
    createdAt: message.created_at,
    editedAt: message.edited_at || null,
    replyTo: channelReplySnippet(message),
    author: { id: Number(message.user_id), username: message.username, verified: Number(message.is_verified) === 1, avatarUrl: message.avatar_url || null, bio: message.bio || '', isBot: Boolean(Number(message.is_bot)), nameStyle: publicNameStyle(message.name_style_json), customBadges: publicCustomBadges(message.custom_badges_json) },
    reactions: reactions.map((reaction) => ({ emoji: reaction.emoji, count: Number(reaction.count), reacted: Boolean(reaction.reacted) })),
    attachments: attachments.map(channelAttachmentPayload),
    poll: publicPoll(message.poll_json, votes, viewerId),
  };
}

function dmReplySnippet(row) {
  if (!row.reply_to_message_id) return null;
  const deleted = Boolean(row.reply_deleted_at) || !row.reply_id;
  const encrypted = Number(row.reply_encryption_version || 0) > 0 || Boolean(row.reply_ciphertext);
  return {
    id: Number(row.reply_to_message_id),
    username: row.reply_username || 'Unknown',
    deleted,
    body: deleted ? '' : encrypted ? 'Message' : String(row.reply_body || ''),
    encrypted: !deleted && encrypted,
    clientMessageId: row.reply_client_id,
    sender: { id: Number(row.reply_sender_id) },
    crypto: !deleted && encrypted ? { version: Number(row.reply_encryption_version || 1), recipientKeys: safeJsonParse(row.reply_group_keys_json), ciphertext: row.reply_ciphertext, iv: row.reply_iv, salt: row.reply_salt,
      senderPublicKey: safeJsonParse(row.reply_sender_key), recipientPublicKey: safeJsonParse(row.reply_recipient_key) } : null,
  };
}

function directMessagePayload(row, attachments) {
  const encrypted = Number(row.encryption_version || 0) > 0;
  const files = attachments || listAttachmentsForMessage.all(row.id);
  return {
    id: Number(row.id),
    body: encrypted ? null : row.body,
    encrypted,
    clientMessageId: row.client_message_id || null,
    crypto: encrypted ? {
      version: Number(row.encryption_version),
      ciphertext: row.ciphertext,
      iv: row.iv,
      salt: row.salt,
      senderPublicKey: safeJsonParse(row.sender_public_key),
      recipientPublicKey: safeJsonParse(row.recipient_public_key),
      recipientKeys: safeJsonParse(row.group_keys_json),
    } : null,
    createdAt: row.created_at,
    editedAt: row.edited_at || null,
    replyTo: dmReplySnippet(row),
    sender: { id: Number(row.sender_id), username: row.sender_username, verified: Number(row.sender_verified) === 1, avatarUrl: row.sender_avatar_url || null, nameStyle: publicNameStyle(row.sender_name_style_json), customBadges: publicCustomBadges(row.sender_custom_badges_json) },
    attachments: files.map(attachmentPayload),
  };
}

function attachmentsByMessageIds(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = database.prepare(`
    SELECT id, message_id, original_name, mime_type, size_bytes, encrypted, iv, salt, sender_public_key, recipient_public_key
    FROM message_attachments WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC
  `).all(...ids);
  for (const row of rows) {
    const id = Number(row.message_id);
    const list = map.get(id) || [];
    list.push(row);
    map.set(id, list);
  }
  return map;
}

function mapByMessageId(rows) {
  const map = new Map();
  for (const row of rows) {
    const id = Number(row.message_id);
    const list = map.get(id) || [];
    list.push(row);
    map.set(id, list);
  }
  return map;
}

function channelAttachmentsByMessageIds(ids) {
  if (!ids.length) return new Map();
  const rows = database.prepare(`
    SELECT id, message_id, original_name, mime_type, size_bytes
    FROM channel_message_attachments
    WHERE message_id IN (${ids.map(() => '?').join(',')})
    ORDER BY id ASC
  `).all(...ids);
  return mapByMessageId(rows);
}

function channelReactionsByMessageIds(viewerId, ids) {
  if (!ids.length) return new Map();
  const rows = database.prepare(`
    SELECT reactions.message_id, reactions.emoji, COUNT(*) AS count,
      SUM(CASE WHEN reactions.user_id = ? THEN 1 ELSE 0 END) AS reacted
    FROM channel_message_reactions reactions
    WHERE reactions.message_id IN (${ids.map(() => '?').join(',')})
    GROUP BY reactions.message_id, reactions.emoji
    ORDER BY reactions.emoji
  `).all(viewerId, ...ids);
  return mapByMessageId(rows);
}

function channelPollVotesByMessageIds(ids) {
  if (!ids.length) return new Map();
  const rows = database.prepare(`
    SELECT message_id, user_id, option_index FROM channel_poll_votes
    WHERE message_id IN (${ids.map(() => '?').join(',')})
  `).all(...ids);
  return mapByMessageId(rows);
}

function hydrateChannelMessageRows(rows, viewerId) {
  const ids = rows.map((row) => Number(row.id));
  const reactionsByMessage = channelReactionsByMessageIds(viewerId, ids);
  const attachmentsByMessage = channelAttachmentsByMessageIds(ids);
  const votesByMessage = channelPollVotesByMessageIds(ids);
  return rows.map((message) => channelMessagePayload(
    message,
    reactionsByMessage.get(Number(message.id)) || [],
    attachmentsByMessage.get(Number(message.id)) || [],
    votesByMessage.get(Number(message.id)) || [],
    viewerId,
  ));
}

function listChannelMessagePayloads(channelId, viewerId, { before = null, limit = 50 } = {}) {
  const bounded = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
  const cursor = Number.isInteger(before) && before > 0 ? before : null;
  const rows = cursor
    ? pageChannelMessages.all(channelId, cursor, bounded + 1)
    : latestChannelMessages.all(channelId, bounded + 1);
  const hasMore = rows.length > bounded;
  const page = rows.slice(0, bounded).reverse();
  return {
    messages: hydrateChannelMessageRows(page, viewerId),
    page: { hasMore, nextBefore: hasMore ? Number(page[0]?.id || 0) : null },
  };
}

function channelMessageFullPayload(channelId, messageId, viewerId) {
  const updated = getChannelMessageRow.get(messageId, channelId);
  if (!updated) return null;
  return hydrateChannelMessageRows([updated], viewerId)[0] || null;
}

function requireSignedInUser(request, response) {
  const user = currentUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Not signed in.' });
    return null;
  }
  if (!findAgreementAcceptance.get(Number(user.id), TERMS_VERSION, CONDUCT_VERSION)) {
    sendJson(response, 403, { error: 'Review and accept the required agreements before using Glean.', agreementRequired: true });
    return null;
  }
  if (!user.username) {
    sendJson(response, 403, { error: 'Choose a username before using direct messages.' });
    return null;
  }
  return user;
}

function publicLoopPost(row) {
  return {
    id: Number(row.id),
    author: {
      id: Number(row.user_id),
      username: row.username || 'Unknown',
      avatarUrl: row.avatar_url || null,
    },
    content: row.body,
    media: row.media_type,
    createdAt: row.created_at,
    likes: Number(row.likes || 0),
    comments: Number(row.comments || 0),
    liked: Boolean(row.liked),
  };
}

function friendshipPair(firstUserId, secondUserId) {
  return firstUserId < secondUserId ? [firstUserId, secondUserId] : [secondUserId, firstUserId];
}

function areFriends(firstUserId, secondUserId) {
  return Boolean(findFriendship.get(...friendshipPair(firstUserId, secondUserId)));
}

function isBlockedEither(firstUserId, secondUserId) {
  return Boolean(findBlock.get(firstUserId, secondUserId) || findBlock.get(secondUserId, firstUserId));
}

function removeFriendship(firstUserId, secondUserId) {
  deleteFriendship.run(...friendshipPair(firstUserId, secondUserId));
  deletePairFriendRequests.run(firstUserId, secondUserId, secondUserId, firstUserId);
}

function requireChannelReply(channelId, replyToMessageId) {
  if (!replyToMessageId) return { id: null };
  const parent = findChannelMessage.get(replyToMessageId);
  if (!parent || Number(parent.channel_id) !== Number(channelId) || parent.deleted_at) return { error: 'That message cannot be replied to.' };
  return { id: replyToMessageId };
}

function requireDirectReply(conversationId, replyToMessageId) {
  if (!replyToMessageId) return { id: null };
  const parent = findDirectReplyParent.get(replyToMessageId);
  if (!parent || Number(parent.conversation_id) !== Number(conversationId) || parent.deleted_at) return { error: 'That message cannot be replied to.' };
  return { id: replyToMessageId };
}

function createDirectConversation(firstUserId, secondUserId, now) {
  const existing = findDirectConversation.get(firstUserId, secondUserId);
  if (existing) return Number(existing.id);
  const conversationId = Number(insertConversation.run(now).lastInsertRowid);
  insertConversationMember.run(conversationId, firstUserId, now);
  insertConversationMember.run(conversationId, secondUserId, now);
  return conversationId;
}

function acceptFriendRequest(requestId, currentUserId, now) {
  const request = findIncomingRequest.get(requestId, currentUserId);
  if (!request) return null;
  updateFriendRequestAccepted.run(request.id);
  insertFriendship.run(...friendshipPair(request.sender_id, currentUserId), now);
  return Number(request.sender_id);
}

const handleMainThemes = createMainThemeService({ database, uploadDirectory, requireSignedInUser, sendJson, readJson, sendLocalFile, takeRateLimit, randomBase32, removeStoredUploads, publicAccount });

const modelMemberRows = database.prepare(`SELECT users.id, users.username, server_members.role_id AS roleId
  FROM server_members JOIN users ON users.id = server_members.user_id WHERE server_members.server_id = ? ORDER BY users.username COLLATE NOCASE`);
const modelRecentMessages = database.prepare(`SELECT channel_messages.id, channel_messages.channel_id AS channelId,
  users.username, substr(channel_messages.body, 1, 300) AS body
  FROM channel_messages JOIN server_channels ON server_channels.id = channel_messages.channel_id
  JOIN users ON users.id = channel_messages.user_id
  WHERE server_channels.server_id = ? AND channel_messages.deleted_at IS NULL ORDER BY channel_messages.id DESC LIMIT 40`);
function serverModelContext(serverId, prompt = '', full = false) {
  const members = modelMemberRows.all(serverId);
  const named = members.filter((member) => prompt.toLowerCase().includes(member.username.toLowerCase()));
  const selected = [...new Map([...named.slice(0, 200), ...members.slice(0, 40)].map((member) => [member.id, member])).values()];
  return {
    server: publicServerSummary(findServerById.get(serverId)),
    roles: listServerRoles.all(serverId).map((role) => ({ ...role, permissionFlags: roleFlags(role) })),
    channels: listServerChannels.all(serverId).map((channel) => publicChannel(channel)),
    categories: serverCategories.list(serverId),
    members: full ? members : selected, memberCount: members.length,
    recentMessages: modelRecentMessages.all(serverId),
  };
}
async function dispatchServerModelApi(parent, path, method, body) {
  const bytes = Buffer.from(JSON.stringify(body || {}));
  const request = Readable.from([bytes]);
  request.method = method;
  request.url = `${apiPrefix}${path}`;
  request.headers = { ...parent.headers, 'content-type': 'application/json', 'content-length': String(bytes.length) };
  delete request.headers['accept-encoding'];
  request.socket = parent.socket;
  let status = 500, payload = null;
  const headers = new Map();
  const response = {
    req: request, destroyed: false, writableEnded: false,
    setHeader: (name, value) => headers.set(name.toLowerCase(), value),
    getHeader: (name) => headers.get(name.toLowerCase()),
    writeHead: (code) => { status = code; },
    end: (data) => { payload = JSON.parse(String(data)); response.writableEnded = true; },
  };
  await handleApi(request, response);
  if (status >= 400 || !payload) throw new Error(payload?.error || 'The server could not apply this action.');
  return payload;
}
const handleServerModel = createServerModelService({
  database, readJson, sendJson, getContext: serverModelContext, callApi: dispatchServerModelApi,
  authorize: (user, id) => {
    const server = findServerById.get(id);
    return Boolean(server && (Number(server.owner_id) === Number(user.id) || isNuperAdmin(user)));
  },
  takeLimit: (request, user, id) => takeRateLimit(request, `server-model:${user.id}:${id}`, 12, 60_000),
  audit: (id, user, planId, results) => writeServerAudit(id, user, 'model.changes-applied', { targetType: 'server', targetId: id, targetName: findServerById.get(id)?.name || '', details: { planId, results } }),
});

messageReports = createMessageReports({
  database, requireUser: requireSignedInUser, readJson, sendJson,
  isReviewer: user => {
    if (isNuperAdmin(user)) return true;
    const id = officialAnnouncements.getServerId();
    const member = id ? findServerMember.get(id, user.id) : null;
    return Boolean(member && ['owner', 'moderator'].includes(member.permissions));
  },
  isProtected: id => isNuperAdmin(findUserById.get(id)),
  channelVisible: (user, id) => canSeeChannel(user, id),
  historyStart: (id, userId) => groupDms.historyStart(id, userId),
  onBlock: (userId, targetId) => { removeFriendship(userId, targetId); emitFriends(userId, 'blocked'); emitFriends(targetId, 'removed'); },
  onRestrict: (id, restriction) => {
    for (const channelId of leaveVoiceRooms(id)) sendEvent(id, 'voice-disconnected', { serverId: findChannel.get(channelId)?.server_id, channelId });
    leaveDmCalls(id, 'restricted'); sendEvent(id, 'account-restricted', restriction);
  },
});

async function answerWithNura(conversationId, userId, imageFiles) {
  const sendTyping = (typing) => {
    sendEvent(userId, 'typing', { conversationId, userId: NURA_USER_ID, username: 'Nura', typing });
  };
  sendTyping(true);
  try {
    const imageParts = imageFiles.map(({ mimeType, bytes }) => ({
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${bytes.toString('base64')}` },
    }));
    const history = listNuraHistory.all(conversationId).reverse().map((message) => ({
      role: Number(message.sender_id) === NURA_USER_ID ? 'assistant' : 'user',
      content: String(message.body || '').slice(-4000) || (Number(message.sender_id) === NURA_USER_ID ? '' : 'What is in this image?'),
    }));
    let remaining = 24_000;
    const boundedHistory = [];
    for (const message of history.toReversed()) {
      if (!remaining) break;
      const content = message.content.slice(-Math.min(remaining, message.content.length));
      if (content) boundedHistory.push({ ...message, content });
      remaining -= content.length;
    }
    boundedHistory.reverse();
    const user = findUserById.get(userId);
    const currentUserMessage = [...boundedHistory].reverse().find((message) => message.role === 'user')?.content || '';
    const currentMood = readNuraMood.get() || { energy: 5, patience: 5, happiness: 5, stress: 3 };
    const currentBond = readNuraBond.get(userId) || { trust: 5, affection: 5, annoyance: 0, last_event: null };
    const { mood: nextMood, bond: nextBond } = applyNuraMoodDelta(currentMood, currentBond, currentUserMessage);
    const moodTimestamp = new Date().toISOString();
    writeNuraMood.run(nextMood.energy, nextMood.patience, nextMood.happiness, nextMood.stress, moodTimestamp);
    writeNuraBond.run(userId, nextBond.trust, nextBond.affection, nextBond.annoyance, nextBond.last_event, moodTimestamp);
    const reply = await requestNuraReply({
      apiKey: process.env.GROQ_API_KEY,
      messages: buildNuraMessages(
        boundedHistory,
        user?.username || 'friend',
        imageParts,
        formatNuraMoodContext(nextMood, nextBond, user?.username || 'friend'),
      ),
    });
    const now = new Date().toISOString();
    const result = insertMessage.run(conversationId, NURA_USER_ID, reply, null, null, null, null, null, null, 0, now, null);
    const responseMessage = directMessagePayload(loadDirectMessageRow.get(Number(result.lastInsertRowid)));
    notifyDirectMessage(conversationId, responseMessage, NURA_USER_ID);
  } catch (error) {
    const fallback = error?.status === 429
      ? 'groq is at its current rate limit. please try again shortly.'
      : 'i couldn’t reach groq just now. please try again in a moment.';
    try {
      const now = new Date().toISOString();
      const result = insertMessage.run(conversationId, NURA_USER_ID, fallback, null, null, null, null, null, null, 0, now, null);
      const responseMessage = directMessagePayload(loadDirectMessageRow.get(Number(result.lastInsertRowid)));
      notifyDirectMessage(conversationId, responseMessage, NURA_USER_ID);
    } catch (storeError) {
      console.error('Nura reply could not be stored:', storeError.message);
    }
  } finally {
    sendTyping(false);
  }
}

const nuraServerRepliesInFlight = new Set();

async function postNuraServerMessage(channelId, serverId, body) {
  const channel = findChannel.get(channelId);
  if (!channel || Number(channel.server_id) !== Number(serverId)) return null;
  let replyBody = String(body || '').trim().slice(0, 4000);
  if (!replyBody) return null;
  let moderationResult = null;
  if (Number(channel.moderation_enabled) === 1) {
    moderationResult = await moderateServerMessage(replyBody, moderationContext(channelId));
    if (moderationResult.fallbackUsed) return null;
    if (moderationResult?.action === 'block') {
      auditModerationResult(channel, { id: NURA_USER_ID, username: 'Nura' }, 'blocked', moderationResult, channelId, 'bot-message');
      replyBody = 'i can’t send that reply here because it was blocked by this server’s moderation settings.';
      moderationResult = null;
    }
  }
  const createdAt = new Date().toISOString();
  const result = insertChannelMessage.run(channelId, NURA_USER_ID, replyBody, createdAt, null, null);
  const messageId = Number(result.lastInsertRowid);
  if (moderationResult && ['warn', 'flag'].includes(moderationResult.action)) auditModerationResult(channel, { id: NURA_USER_ID, username: 'Nura' }, moderationResult.action, moderationResult, messageId, 'bot-message');
  const message = channelMessageFullPayload(channelId, messageId, NURA_USER_ID);
  notifyChannelMessageCreated(serverId, { serverId: Number(serverId), channelId: Number(channelId), action: 'created', message }, NURA_USER_ID);
  return message;
}

async function answerWithNuraInServer({ channelId, serverId, authorId, promptText = '' }) {
  const key = Number(channelId);
  if (nuraServerRepliesInFlight.has(key)) return null;
  nuraServerRepliesInFlight.add(key);
  try {
    const history = listNuraServerHistory.all(key).slice(0, 6).reverse().map((message) => ({
      role: Number(message.is_bot) ? 'assistant' : 'user',
      content: Number(message.is_bot)
        ? String(message.body || '').slice(0, 700)
        : `${String(message.username || 'member').slice(0, 24)}: ${String(message.body || '').slice(0, 700)}`,
    }));
    const lastUserIndex = history.findLastIndex((message) => message.role === 'user');
    if (lastUserIndex < 0) return null;
    if (promptText) history[lastUserIndex].content = String(promptText).slice(0, 1400);
    const author = findUserById.get(Number(authorId));
    const channel = findChannel.get(key);
    const server = findServerById.get(Number(serverId));
    const mood = readNuraMood.get() || { energy: 5, patience: 5, happiness: 5, stress: 3 };
    const context = [
      formatNuraMoodContext(mood, { trust: 5, affection: 5, annoyance: 0, last_event: null }, 'the server'),
      '### SERVER CHAT',
      `You are replying in #${String(channel?.name || 'channel').slice(0, 32)} in ${String(server?.name || 'a Glean server').slice(0, 60)}. This is a shared channel, not a private DM. Do not reveal or imply access to private DMs, private user memories, or system secrets.`,
    ].join('\n');
    const reply = await requestNuraReply({
      apiKey: process.env.GROQ_API_KEY,
      messages: buildNuraMessages(history, author?.username || 'friend', [], context),
      maxTokens: 512,
    });
    return await postNuraServerMessage(key, Number(serverId), reply);
  } catch (error) {
    const fallback = error?.status === 429
      ? 'groq is at its current rate limit. please try again shortly.'
      : 'i couldn’t reach groq just now. please try again in a moment.';
    try { return await postNuraServerMessage(key, Number(serverId), fallback); }
    catch (storeError) { console.error('Nura server reply could not be stored:', storeError.message); return null; }
  } finally {
    nuraServerRepliesInFlight.delete(key);
  }
}

async function handleApi(request, response) {
  const { method } = request;
  const rawPath = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
  const path = rawPath.startsWith(apiPrefix) ? `/api${rawPath.slice(apiPrefix.length)}` : rawPath;
  const user = currentUser(request);
  const agreementsAllowedBeforeAcceptance = new Set([
    '/api', '/api/v1', '/api/health', '/api/access/status', '/api/auth/me', '/api/auth/signin', '/api/auth/signup',
    '/api/auth/signout', '/api/account/agreements', '/api/announcement',
  ]);
  if (user && !findAgreementAcceptance.get(Number(user.id), TERMS_VERSION, CONDUCT_VERSION) && !agreementsAllowedBeforeAcceptance.has(path)) {
    return sendJson(response, 403, { error: 'Review and accept the required agreements before using Glean.', agreementRequired: true });
  }
  const now = new Date().toISOString();
  deleteExpiredSessions.run(now);
  deleteExpiredTimeouts.run(now);
  pruneRateLimits();

  const restriction = user && messageReports.getRestriction(user.id);
  const restrictionSafe = ['/api/auth/signin', '/api/auth/signup', '/api/auth/signout'].includes(path) || path.startsWith('/api/e2ee/')
    || ['/api/account/password', '/api/account/agreements', '/api/account/sessions/others', '/api/message-reports', '/api/blocks'].includes(path)
    || /^\/api\/account\/sessions\//.test(path) || /\/read$/.test(path) || (path === '/api/account' && method === 'DELETE')
    || path === '/api/account/notifications' || /^\/api\/conversations\/\d+\/mute$/.test(path) || /^\/api\/servers\/\d+\/mute$/.test(path) || /^\/api\/conversations\/\d+\/group\/leave$/.test(path);
  if (restriction && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !restrictionSafe) {
    return sendJson(response, 403, { error: `Your account is restricted until ${restriction.until}. ${restriction.reason}`, restriction });
  }
  if (path === '/api/account/restriction' && method === 'GET') return sendJson(response, user ? 200 : 401, user ? { restriction } : { error: 'Not signed in.' });
  if (await messageReports.handle(request, response, path, method)) return;
  if (await notificationPreferences.handle(request, response, path, method)) return;

  if (await handleMainThemes(request, response, path, method)) return;

  if ((path === '/api' || path === '/api/v1') && method === 'GET') {
    const routes = {
      health: `${apiPrefix}/health`,
      signIn: `${apiPrefix}/auth/signin`,
      signUp: `${apiPrefix}/auth/signup`,
      currentAccount: `${apiPrefix}/auth/me`,
      servers: `${apiPrefix}/servers`,
      conversations: `${apiPrefix}/conversations`,
    };
    if (loopRoutesEnabled) routes.loopPosts = `${apiPrefix}/loop/posts`;
    return sendJson(response, 200, {
      service: 'glean',
      version: '1',
      baseUrl: `${apiPrefix}`,
      realtimeUrl: `${apiPrefix}/realtime`,
      routes,
    });
  }
  if (path === '/api/health' && method === 'GET') return sendJson(response, 200, { ok: true, service: 'glean', now });
  if (path === '/api/voice/ice-servers' && method === 'GET') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const retryAfter = takeRateLimit(request, `voice-ice:${user.id}`, 30, 60_000);
    if (retryAfter) return sendJson(response, 429, { error: 'Voice setup requested too often. Try again shortly.' }, { 'Retry-After': String(retryAfter) });
    const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    if (GLEAN_TURN_URLS.length && GLEAN_TURN_SECRET) {
      const username = `${expiresAt}:${Number(user.id)}`;
      const credential = createHmac('sha1', GLEAN_TURN_SECRET).update(username).digest('base64');
      iceServers.push({ urls: GLEAN_TURN_URLS, username, credential });
    }
    return sendJson(response, 200, { iceServers, credentialExpiresAt: GLEAN_TURN_URLS.length && GLEAN_TURN_SECRET ? expiresAt : null });
  }
  if (method === 'GET' && path === '/api/gifs/search') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const gifUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const query = String(gifUrl.searchParams.get('q') || '').trim().slice(0, 80);
    const offset = Math.max(0, Math.min(480, Number.parseInt(gifUrl.searchParams.get('offset') || '0', 10) || 0));
    if (!query) return sendJson(response, 200, { gifs: [] });
    try {
      if (!GIPHY_API_KEY) return sendJson(response, 503, { error: 'GIPHY search is not configured.' });
      const upstream = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(GIPHY_API_KEY)}&q=${encodeURIComponent(query)}&limit=24&offset=${offset}&rating=pg-13&lang=en`);
      if (!upstream.ok) return sendJson(response, 502, { error: 'GIF search is temporarily unavailable.' });
      const payload = await upstream.json();
      const gifs = Array.isArray(payload.data) ? payload.data.map((gif) => ({ id: String(gif.id), title: String(gif.title || 'GIF'), url: gif.images?.original?.url || gif.images?.downsized?.url || gif.images?.fixed_width?.url || '', previewUrl: gif.images?.fixed_width?.url || gif.images?.fixed_width_small?.url || gif.images?.downsized_small?.url || gif.images?.preview_gif?.url || gif.images?.original?.url || '' })).filter((gif) => gif.url && gif.previewUrl) : [];
      const total = Number(payload.pagination?.total_count || 0);
      const nextOffset = offset + gifs.length;
      return sendJson(response, 200, { gifs, nextOffset, hasMore: gifs.length === 24 && (!total || nextOffset < total) });
    } catch { return sendJson(response, 502, { error: 'GIF search is temporarily unavailable.' }); }
  }
  if (method === 'GET' && path === '/api/gifs/download') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const downloadUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const id = String(downloadUrl.searchParams.get('id') || '');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return sendJson(response, 400, { error: 'Invalid GIF.' });
    try {
      if (!GIPHY_API_KEY) return sendJson(response, 503, { error: 'GIPHY search is not configured.' });
      const metadata = await fetch(`https://api.giphy.com/v1/gifs/${encodeURIComponent(id)}?api_key=${encodeURIComponent(GIPHY_API_KEY)}`);
      if (!metadata.ok) return sendJson(response, 404, { error: 'GIF not found.' });
      const gif = (await metadata.json()).data;
      const source = gif?.images?.downsized?.url || gif?.images?.original?.url;
      if (!source || !/^https:\/\/[^/]+\.giphy\.com\//i.test(source)) return sendJson(response, 502, { error: 'GIF is unavailable.' });
      const upstream = await fetch(source);
      const size = Number(upstream.headers.get('content-length') || 0);
      if (!upstream.ok || size > 15 * 1024 * 1024) return sendJson(response, 413, { error: 'That GIF is too large.' });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (bytes.length > 15 * 1024 * 1024) return sendJson(response, 413, { error: 'That GIF is too large.' });
      response.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': `attachment; filename="giphy-${id}.gif"` });
      return response.end(bytes);
    } catch { return sendJson(response, 502, { error: 'GIF download failed.' }); }
  }
  if (path === '/api/auth/stats' && method === 'GET') {
    const users = listUsersForAdmin.all();
    const online = users.reduce((count, user) => count + (realtimeHub.connectedCount(Number(user.id)) > 0 ? 1 : 0), 0);
    const servers = Number(countAuthServers.get()?.count || 0);
    return sendJson(response, 200, { online, total: users.length, servers });
  }
  if (path === '/api/push/vapid' && method === 'GET') return sendJson(response, 200, { publicKey: pushService.publicKey });
  if (!isSameOriginRequest(request)) return sendJson(response, 403, { error: 'Cross-site request blocked.' });
  const authRoute = path.startsWith('/api/auth/signin') || path.startsWith('/api/auth/signup');
  const messageRoute = /\/messages(?:\/|$)/.test(path) || path.endsWith('/typing');
  const retryAfter = takeRateLimit(request, authRoute ? 'auth' : messageRoute ? 'messages' : 'api', authRoute ? 20 : messageRoute ? 240 : 600, 60_000);
  if (retryAfter) return sendJson(response, 429, { error: 'Too many requests. Try again shortly.' }, { 'Retry-After': String(retryAfter) });

  if (await handleServerModel(request, response, path, method, user)) return;
  if (await handleFeedbackSurvey(request, response, path, method)) return;
  if (await serverCategories.handle(request, response, path, method, user)) return;

  if (method === 'POST' && path === '/api/error-reports') {
    const input = await readJson(request, 24 * 1024);
    const clean = (value, max) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
    const report = {
      id: randomBase32(10),
      createdAt: now,
      kind: clean(input.kind, 24) || 'unknown',
      route: clean(input.route, 180) || '/',
      title: clean(input.title, 160),
      message: clean(input.message, 5000),
    };
    const reportPath = join(errorReportsDirectory, `${now.slice(0, 10)}.jsonl`);
    appendFileSync(reportPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });
    return sendJson(response, 201, { ok: true, reportId: report.id });
  }

  if (path === '/api/account/agreements') {
    const agreementUser = currentUser(request);
    if (!agreementUser) return sendJson(response, 401, { error: 'Not signed in.' });
    if (method === 'GET') {
      updateAgreementPromptedAt.run(new Date().toISOString(), agreementUser.id);
      return sendJson(response, 200, {
        accepted: Boolean(findAgreementAcceptance.get(Number(agreementUser.id), TERMS_VERSION, CONDUCT_VERSION)),
        termsVersion: TERMS_VERSION,
        conductVersion: CONDUCT_VERSION,
        waitSeconds: AGREEMENT_WAIT_SECONDS,
      });
    }
    if (method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
    let input;
    try { input = await readJson(request, 2048); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    if (input.termsAccepted !== true || input.conductAccepted !== true) return sendJson(response, 400, { error: 'Both agreements must be accepted.' });
    if (input.termsVersion !== TERMS_VERSION || input.conductVersion !== CONDUCT_VERSION) return sendJson(response, 409, { error: 'The agreement changed. Reload and review the current documents.' });
    const promptedAt = Date.parse(agreementUser.agreement_prompted_at || '');
    const elapsed = Date.now() - promptedAt;
    if (!Number.isFinite(promptedAt) || elapsed < AGREEMENT_WAIT_SECONDS * 1000) {
      const retryAfterSeconds = Math.max(1, Math.ceil((AGREEMENT_WAIT_SECONDS * 1000 - Math.max(0, elapsed)) / 1000));
      return sendJson(response, 425, { error: `Please wait ${retryAfterSeconds} more seconds before continuing.`, retryAfterSeconds }, { 'Retry-After': String(retryAfterSeconds) });
    }
    const acceptedAt = new Date().toISOString();
    withTransaction(() => {
      recordAgreementAcceptance.run(Number(agreementUser.id), TERMS_VERSION, CONDUCT_VERSION, acceptedAt);
      updateAgreementPromptedAt.run(null, Number(agreementUser.id));
    });
    const updatedAccount = grantNamedPlatformAdmin(findUserById.get(Number(agreementUser.id)));
    return sendJson(response, 200, { account: publicAccount(updatedAccount), acceptedAt });
  }

  if (method === 'POST' && path === '/api/auth/signup') {
    const { username, password, grade, school } = await readJson(request);
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) return sendJson(response, 400, { error: USERNAME_RULES_MESSAGE });
    if (typeof password !== 'string' || password.length < 10 || password.length > 256) return sendJson(response, 400, { error: 'Use a password between 10 and 256 characters.' });
    const hasGrade = grade != null && String(grade).trim() !== '';
    const hasSchool = school != null && String(school).trim() !== '';
    const cleanGrade = hasGrade ? publicGrade(grade) : null;
    const cleanSchool = hasSchool ? publicSchool(school) : null;
    if (hasGrade && !cleanGrade) return sendJson(response, 400, { error: 'Choose a grade option to continue.' });
    if (hasSchool && !cleanSchool) return sendJson(response, 400, { error: 'Choose a school option to continue.' });
    if (cleanSchool && !cleanGrade) return sendJson(response, 400, { error: 'Choose a grade option to continue.' });
    if (cleanGrade && cleanSchool && !schoolFitsGrade(cleanSchool, cleanGrade)) return sendJson(response, 400, { error: 'Choose a school that matches your grade.' });
    if (findUserByUsername.get(normalizedUsername)) return sendJson(response, 409, { error: 'That username is already taken.' });

    const salt = randomBytes(16).toString('hex');
    const generatedEmail = `${normalizedUsername.toLowerCase()}@glean.io`;
    const result = insertUser.run(Number(nextAccountId.get().id), generatedEmail, hashPassword(password, salt), salt, normalizedUsername, now, now, cleanGrade, cleanSchool);
    const user = grantNamedPlatformAdmin({ id: Number(result.lastInsertRowid), email: generatedEmail, username: normalizedUsername, bio: '', created_at: now, last_visited_at: now, grade: cleanGrade, school: cleanSchool });
    const officialServerId = officialAnnouncements.getServerId();
    const officialDeviceHash = officialServerId ? serverDeviceHash(request, officialServerId) : null;
    officialAnnouncements.enroll(user.id, officialDeviceHash);
    const session = createSession(response, user.id);
    return sendJson(response, 201, { account: publicAccount(user), ...session });
  }

  if (method === 'POST' && path === '/api/auth/signin') {
    const { username, email, password } = await readJson(request);
    const identifier = String(username || email || '').trim();
    const byUsername = findUserByUsername.get(normalizeUsername(identifier));
    const user = byUsername ? findUserById.get(byUsername.id) : findUserByEmail.get(normalizeEmail(identifier));
    if (!user || typeof password !== 'string') return sendJson(response, 401, { error: 'That email or password is incorrect.' });

    const submittedHash = Buffer.from(hashPassword(password, user.password_salt), 'hex');
    const storedHash = Buffer.from(user.password_hash, 'hex');
    if (submittedHash.length !== storedHash.length || !timingSafeEqual(submittedHash, storedHash)) {
      return sendJson(response, 401, { error: 'That email or password is incorrect.' });
    }

    const session = createSession(response, user.id);
    return sendJson(response, 200, { account: publicAccount(user), ...session });
  }

  if (method === 'GET' && path === '/api/auth/me') {
    const user = currentUser(request);
    if (!user) return sendJson(response, 401, { error: 'Not signed in.' });
    const sessionToken = parseCookies(request).glean_session;
    if (sessionToken && !/^[a-z2-7]{52}$/.test(sessionToken)) {
      deleteSession.run(hashSessionToken(sessionToken));
      createSession(response, user.id);
    }
    return sendJson(response, 200, { account: publicAccount(user) });
  }

  if (!loopRoutesEnabled && (path === '/api/loop' || path.startsWith('/api/loop/'))) return sendJson(response, 404, { error: 'Not found.' });
  if (await videoDownloadService.route(request, response, path)) return;
  if (loopRoutesEnabled && path.startsWith('/api/loop/') && await loopService.route(request, response, path, now)) return;

  if (loopRoutesEnabled && method === 'GET' && path === '/api/loop/posts') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const posts = listLoopPosts.all(user.id, 100).map(publicLoopPost);
    return sendJson(response, 200, { posts });
  }

  if (loopRoutesEnabled && method === 'POST' && path === '/api/loop/posts') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const payload = await readJson(request);
    const content = String(payload.content || '').trim();
    const media = ['none', 'photo', 'gif', 'video'].includes(payload.media) ? payload.media : 'none';
    const clientId = typeof payload.clientId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(payload.clientId) ? payload.clientId : null;
    if (!content && media === 'none') return sendJson(response, 400, { error: 'Write something or add media before posting.' });
    if (content.length > 2000) return sendJson(response, 400, { error: 'Loop posts can be up to 2,000 characters.' });
    const existingPostId = clientId ? Number(findLoopPostByClientId.get(user.id, clientId)?.id || 0) : 0;
    const postId = existingPostId || Number(insertLoopPost.run(user.id, content, media, clientId, now).lastInsertRowid);
    const post = loadLoopPost.get(user.id, postId);
    return sendJson(response, existingPostId ? 200 : 201, { post: publicLoopPost(post) });
  }

  const loopLikeMatch = path.match(/^\/api\/loop\/posts\/(\d+)\/like$/);
  if (loopRoutesEnabled && method === 'POST' && loopLikeMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const postId = Number(loopLikeMatch[1]);
    if (!findLoopPost.get(postId)) return sendJson(response, 404, { error: 'Loop post not found.' });
    const liked = !findLoopLike.get(postId, user.id);
    if (liked) insertLoopLike.run(postId, user.id, now);
    else deleteLoopLike.run(postId, user.id);
    return sendJson(response, 200, { liked, likes: Number(countLoopLikes.get(postId).count || 0) });
  }

  const loopCommentMatch = path.match(/^\/api\/loop\/posts\/(\d+)\/comments$/);
  if (loopRoutesEnabled && method === 'POST' && loopCommentMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const postId = Number(loopCommentMatch[1]);
    if (!findLoopPost.get(postId)) return sendJson(response, 404, { error: 'Loop post not found.' });
    const { content } = await readJson(request);
    const comment = String(content || '').trim();
    if (!comment || comment.length > 1000) return sendJson(response, 400, { error: 'Comments must be between 1 and 1,000 characters.' });
    insertLoopComment.run(postId, user.id, comment, now);
    return sendJson(response, 201, { comments: Number(countLoopComments.get(postId).count || 0) });
  }

  if (method === 'POST' && path === '/api/auth/username') {
    const user = currentUser(request);
    if (!user) return sendJson(response, 401, { error: 'Not signed in.' });
    const { username } = await readJson(request);
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) return sendJson(response, 400, { error: USERNAME_RULES_MESSAGE });
    const owner = findUserByUsername.get(normalizedUsername);
    if (owner && owner.id !== user.id) return sendJson(response, 409, { error: 'That username is already taken.' });
    try {
      updateUsername.run(normalizedUsername, user.id);
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) return sendJson(response, 409, { error: 'That username is already taken.' });
      throw error;
    }
    return sendJson(response, 200, { account: publicAccount(grantNamedPlatformAdmin({ ...user, username: normalizedUsername })) });
  }

  if (method === 'POST' && path === '/api/auth/signout') {
    const token = requestSessionToken(request);
    if (token) {
      const hash = hashSessionToken(token);
      deleteSession.run(hash);
      realtimeHub.dropSession(hash);
    }
    response.setHeader('Set-Cookie', sessionCookie('', 0));
    return sendJson(response, 200, { ok: true });
  }

  if (method === 'POST' && path === '/api/account/password') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    const currentPassword = String(input.currentPassword || '');
    const nextPassword = String(input.newPassword || '');
    if (nextPassword.length < 10 || nextPassword.length > 256) return sendJson(response, 400, { error: 'Use a password between 10 and 256 characters.' });
    const row = findUserById.get(user.id);
    if (!row) return sendJson(response, 401, { error: 'Not signed in.' });
    const submittedHash = Buffer.from(hashPassword(currentPassword, row.password_salt), 'hex');
    const storedHash = Buffer.from(row.password_hash, 'hex');
    if (submittedHash.length !== storedHash.length || !timingSafeEqual(submittedHash, storedHash)) {
      return sendJson(response, 401, { error: 'That password is incorrect.' });
    }
    const profileKeyBackup = input.profileKeyBackup;
    const existingProfileBackup = readProfileKeyBackup.get(user.id);
    const usesProfileKeyBackup = String(user.username || '').toLowerCase() === 'nuper';
    if (usesProfileKeyBackup && (row.public_key_jwk || existingProfileBackup) && !profileKeyBackup) {
      return sendJson(response, 409, { error: 'Update Glean before changing your password so your DM recovery backup stays usable.' });
    }
    let encodedProfileBackup = null;
    if (profileKeyBackup) {
      const currentFingerprint = storedPublicKeyFingerprint(row.public_key_jwk, row.key_fingerprint);
      if (!Number.isSafeInteger(profileKeyBackup.revision) || profileKeyBackup.revision < 0
        || !profileKeyBackup.publicKey || !publicKeyMatchesStored(profileKeyBackup.publicKey, row.public_key_jwk, row.key_fingerprint)
        || String(profileKeyBackup.fingerprint || '').toLowerCase() !== currentFingerprint
        || !validAccountKeyBackup(profileKeyBackup.backup)) return sendJson(response, 400, { error: 'The encrypted DM recovery backup is invalid. Your password was not changed.' });
      if (Number(existingProfileBackup?.revision || 0) !== profileKeyBackup.revision) return sendJson(response, 409, { error: 'The DM recovery backup changed. Retry your password change.' });
      encodedProfileBackup = JSON.stringify(profileKeyBackup.backup);
    }
    const salt = randomBytes(16).toString('hex');
    try {
      withTransaction(() => {
        const backupResult = profileKeyBackup
          ? profileKeyBackup.revision === 0
            ? createProfileKeyBackup.run(user.id, encodedProfileBackup, now)
            : replaceProfileKeyBackup.run(encodedProfileBackup, now, user.id, profileKeyBackup.revision)
          : null;
        if (profileKeyBackup && !backupResult?.changes) throw Object.assign(new Error('The DM recovery backup changed. Retry your password change.'), { code: 'E2EE_PROFILE_BACKUP_CONFLICT' });
        updatePassword.run(hashPassword(nextPassword, salt), salt, user.id);
      });
    } catch (error) {
      if (error.code === 'E2EE_PROFILE_BACKUP_CONFLICT') return sendJson(response, 409, { error: error.message });
      throw error;
    }
    const revoked = deleteOtherSessions.run(user.id, user.sessionHash);
    realtimeHub.dropUserExcept(user.id, user.sessionHash);
    return sendJson(response, 200, { ok: true, revoked: Number(revoked.changes || 0) });
  }

  if (method === 'DELETE' && path === '/api/account') {
    const account = requireSignedInUser(request, response);
    if (!account) return;
    const deleteRetryAfter = takeRateLimit(request, `account-delete:${account.id}`, 3, 60 * 60_000);
    if (deleteRetryAfter) return sendJson(response, 429, { error: 'Too many attempts. Try again later.' }, { 'Retry-After': String(deleteRetryAfter) });
    let input = {};
    try { input = await readJson(request, 1024); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    if (typeof input.password !== 'string' || !input.password.length || input.password.length > 256) {
      return sendJson(response, 400, { error: 'Enter your current password to delete your account.' });
    }
    const userRow = findUserById.get(Number(account.id));
    if (!userRow) return sendJson(response, 401, { error: 'Not signed in.' });
    const submittedHash = Buffer.from(hashPassword(input.password, userRow.password_salt), 'hex');
    const storedHash = Buffer.from(userRow.password_hash, 'hex');
    if (submittedHash.length !== storedHash.length || !timingSafeEqual(submittedHash, storedHash)) {
      return sendJson(response, 401, { error: 'That password is incorrect.' });
    }

    const accountId = Number(account.id);
    const deletedAt = new Date().toISOString();
    const directConversationIds = database.prepare('SELECT conversation_id FROM conversation_members WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM group_conversations g WHERE g.conversation_id = conversation_members.conversation_id)').all(accountId).map((row) => Number(row.conversation_id));
    const loopConversationIds = database.prepare('SELECT conversation_id FROM loop_conversation_members WHERE user_id = ?').all(accountId).map((row) => Number(row.conversation_id));
    const ownedServerRows = database.prepare('SELECT id, icon_url, banner_json FROM servers WHERE owner_id = ?').all(accountId);
    const ownedServerIds = ownedServerRows.map((row) => Number(row.id));
    const ownedChannelRows = ownedServerIds.length
      ? database.prepare(`SELECT id, server_id, voice FROM server_channels WHERE server_id IN (${ownedServerIds.map(() => '?').join(',')})`).all(...ownedServerIds)
      : [];
    const boardScopeKeys = [
      ...directConversationIds.map((id) => `d:${id}`),
      ...ownedChannelRows.filter((row) => Boolean(row.voice)).map((row) => `c:${Number(row.server_id)}:${Number(row.id)}`),
    ];
    const mediaNames = new Set();
    const collectNames = (rows) => rows.forEach((row) => {
      if (typeof row.storage_name === 'string' && /^(?:[a-z2-7]{20,64}|[a-z2-7-]+\.[a-z0-9]+)$/.test(row.storage_name)) mediaNames.add(row.storage_name);
    });
    collectNames(database.prepare(`SELECT storage_name FROM message_attachments WHERE uploaded_by = ? OR (conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ?) AND NOT EXISTS (SELECT 1 FROM group_conversations g WHERE g.conversation_id = message_attachments.conversation_id))`).all(accountId, accountId));
    collectNames(database.prepare(`SELECT storage_name FROM channel_message_attachments WHERE uploaded_by = ? OR channel_id IN (SELECT c.id FROM server_channels c JOIN servers s ON s.id = c.server_id WHERE s.owner_id = ?) OR message_id IN (SELECT id FROM channel_messages WHERE user_id = ?)`).all(accountId, accountId, accountId));
    collectNames(database.prepare('SELECT m.storage_name FROM loop_post_media m JOIN loop_posts p ON p.id = m.post_id WHERE p.user_id = ?').all(accountId));
    if (boardScopeKeys.length) {
      collectNames(database.prepare(`SELECT storage_name FROM app_board_images WHERE uploaded_by = ? OR board_id IN (SELECT id FROM app_boards WHERE scope_key IN (${boardScopeKeys.map(() => '?').join(',')}))`).all(accountId, ...boardScopeKeys));
    } else {
      collectNames(database.prepare('SELECT storage_name FROM app_board_images WHERE uploaded_by = ?').all(accountId));
    }
    const avatarName = String(userRow.avatar_url || '').match(/^\/api\/v1\/avatars\/(avatar-[a-z2-7]+\.(?:jpg|png|webp|gif))$/)?.[1];
    if (avatarName) mediaNames.add(avatarName);
    const ownBannerName = bannerFileName(publicBanner(userRow.banner_json));
    if (ownBannerName) mediaNames.add(ownBannerName);
    const backgroundName = publicProfileBackground(userRow.profile_background_json)?.imageUrl?.match(PROFILE_BACKGROUND_URL)?.[1];
    if (backgroundName) mediaNames.add(backgroundName);
    for (const theme of normalizeMainThemes(userRow.main_theme_json).custom) {
      const themeName = theme.imageUrl?.match(MAIN_THEME_IMAGE_URL)?.[1];
      if (themeName) mediaNames.add(themeName);
    }
    for (const server of ownedServerRows) {
      const iconName = serverIconFileName(server.icon_url);
      const bannerName = bannerFileName(publicServerBanner(server.banner_json));
      if (iconName) mediaNames.add(iconName);
      if (bannerName) mediaNames.add(bannerName);
    }

    const retiredId = database.prepare('INSERT INTO retired_account_ids (id, deleted_at) VALUES (?, ?)');
    let changedGroups = [];
    const groupUploads = [];
    withTransaction(() => {
      retiredId.run(accountId, deletedAt);
      database.prepare("UPDATE server_audit_log SET actor_name = 'Deleted user' WHERE actor_user_id = ?").run(accountId);
      database.prepare("UPDATE server_audit_log SET target_name = 'Deleted user', target_id = '' WHERE target_type IN ('user', 'member') AND target_id = ?").run(String(accountId));
      database.prepare('UPDATE channel_message_cleanup_schedules SET updated_by = NULL WHERE updated_by = ?').run(accountId);
      for (const scopeKey of boardScopeKeys) database.prepare('DELETE FROM app_boards WHERE scope_key = ?').run(scopeKey);
      changedGroups = groupDms.detachUser(accountId, groupUploads);
      deleteDirectConversationsForUser.run(accountId);
      database.prepare('DELETE FROM loop_conversations WHERE id IN (SELECT conversation_id FROM loop_conversation_members WHERE user_id = ?)').run(accountId);
      database.prepare('DELETE FROM channel_messages WHERE user_id = ?').run(accountId);
      database.prepare('DELETE FROM servers WHERE owner_id = ?').run(accountId);
      database.prepare('DELETE FROM users WHERE id = ?').run(accountId);
    });
    for (const id of changedGroups) groupDms.notify(id);
    leaveVoiceRooms(accountId);
    leaveDmCalls(accountId, 'account-deleted');
    appService.dropUserEverywhere(accountId);
    realtimeHub.dropUserExcept(accountId, null);
    removeStoredUploads([...mediaNames, ...groupUploads]);
    response.setHeader('Set-Cookie', sessionCookie('', 0));
    return sendJson(response, 200, { ok: true });
  }

  if (method === 'GET' && path === '/api/account/sessions') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    return sendJson(response, 200, {
      sessions: listUserSessions.all(user.id, now).map((session) => {
        let publicId = session.public_id;
        if (!publicId) {
          publicId = randomBase32(12);
          updateSessionPublicId.run(publicId, session.token_hash);
        }
        return {
          id: publicId,
          current: session.token_hash === user.sessionHash,
          device: session.token_hash === user.sessionHash ? 'This device' : 'Other signed-in session',
        };
      }),
    });
  }

  if (method === 'DELETE' && path === '/api/account/sessions/others') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const revoked = deleteOtherSessions.run(user.id, user.sessionHash);
    realtimeHub.dropUserExcept(user.id, user.sessionHash);
    return sendJson(response, 200, { ok: true, revoked: Number(revoked.changes || 0) });
  }

  const sessionDeleteMatch = path.match(/^\/api\/account\/sessions\/([a-z2-7]{16,32})$/i);
  if (method === 'DELETE' && sessionDeleteMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const publicId = sessionDeleteMatch[1].toLowerCase();
    const row = findSessionTokenByPublicId.get(publicId, user.id);
    if (!row) return sendJson(response, 404, { error: 'That device is no longer signed in.' });
    deleteSessionByPublicId.run(publicId, user.id);
    realtimeHub.dropSession(row.token_hash);
    const signedOut = row.token_hash === user.sessionHash;
    if (signedOut) response.setHeader('Set-Cookie', sessionCookie('', 0));
    return sendJson(response, 200, { ok: true, signedOut });
  }

  if ((method === 'POST' || method === 'PATCH') && path === '/api/account/presence') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    setPresenceHidden(user.id, input.hidden === true);
    const next = findUserById.get(user.id);
    return sendJson(response, 200, { account: publicAccount(grantNamedPlatformAdmin(next)) });
  }

  if ((method === 'POST' || method === 'PATCH') && path === '/api/account/keep-information-secret') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    if (typeof input.enabled !== 'boolean') return sendJson(response, 400, { error: 'enabled must be true or false.' });
    setKeepInformationSecret(user.id, input.enabled);
    return sendJson(response, 200, { account: publicAccount(grantNamedPlatformAdmin(findUserById.get(user.id))) });
  }

  if ((method === 'POST' || method === 'PATCH') && path === '/api/account/presence-status') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    if (!setPresenceStatus(user.id, String(input.status || 'auto'))) return sendJson(response, 400, { error: 'Status must be auto, online, idle, dnd, or offline.' });
    return sendJson(response, 200, { account: publicAccount(grantNamedPlatformAdmin(findUserById.get(user.id))) });
  }

  if ((method === 'POST' || method === 'PATCH') && path === '/api/account/inspect-servers') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    if (!isPlatformAdmin(user)) return sendJson(response, 403, { error: 'Only platform admins can change hidden servers.' });
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    updateShowInspectServers.run(input.show === false ? 0 : 1, user.id);
    const next = findUserById.get(user.id);
    return sendJson(response, 200, { account: publicAccount(grantNamedPlatformAdmin(next)) });
  }

  if ((method === 'POST' || method === 'PATCH') && path === '/api/account/private-notes') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    updatePrivateNotesEnabled.run(input.enabled === false ? 0 : 1, user.id);
    return sendJson(response, 200, { account: publicAccount(grantNamedPlatformAdmin(findUserById.get(user.id))) });
  }

  if ((method === 'POST' || method === 'PATCH') && path === '/api/account/accessibility') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    const contrast = Number(input.contrast);
    const saturation = Number(input.saturation);
    const glassFrost = Number(input.glassFrost ?? 50);
    const glassDepth = Number(input.glassDepth ?? user.accessibility_glass_depth ?? 20);
    const glassRefraction = Number(input.glassRefraction ?? user.accessibility_glass_refraction ?? 100);
    const theme = input.theme ?? user.accessibility_theme ?? 'system';
    const showLoopStreakReminder = input.showLoopStreakReminder ?? (user.accessibility_loop_streak_reminder == null ? true : Boolean(Number(user.accessibility_loop_streak_reminder)));
    if (!Number.isInteger(contrast) || contrast < 50 || contrast > 150 || !Number.isInteger(saturation) || saturation < 0 || saturation > 200 || typeof input.reduceMotion !== 'boolean' || !Number.isInteger(glassFrost) || glassFrost < 0 || glassFrost > 100 || !Number.isInteger(glassDepth) || glassDepth < 0 || glassDepth > 100 || !Number.isInteger(glassRefraction) || glassRefraction < 0 || glassRefraction > 100 || !['system', 'light', 'dark'].includes(theme) || typeof showLoopStreakReminder !== 'boolean') {
      return sendJson(response, 400, { error: 'Contrast must be 50-150, saturation 0-200, and glass frost, depth, and refraction must be 0-100.' });
    }
    updateAccessibilitySettings.run(contrast, saturation, input.reduceMotion ? 1 : 0, glassFrost, glassDepth, glassRefraction, theme, showLoopStreakReminder ? 1 : 0, user.id);
    return sendJson(response, 200, { account: publicAccount(grantNamedPlatformAdmin(findUserById.get(user.id))) });
  }

  if (method === 'POST' && path === '/api/push/subscribe') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    try {
      const body = await readJson(request);
      pushService.subscribe(user.id, body.subscription || body, now);
      return sendJson(response, 200, { ok: true });
    } catch (error) {
      return sendJson(response, 400, { error: error.message || 'Unable to save that subscription.' });
    }
  }

  if (method === 'DELETE' && path === '/api/push/subscribe') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const { endpoint } = await readJson(request);
    pushService.unsubscribe(user.id, endpoint);
    return sendJson(response, 200, { ok: true });
  }

  if (method === 'POST' && path === '/api/e2ee/reset') {
    const account = requireSignedInUser(request, response);
    if (!account) return;
    const retry = takeRateLimit(request, `e2ee-reset:${account.id}`, 3, 60 * 60_000);
    if (retry) return sendJson(response, 429, { error: 'Too many key reset attempts. Try again later.' }, { 'Retry-After': String(retry) });
    let input;
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    const password = typeof input.password === 'string' ? input.password : '';
    const { revision, publicKey, fingerprint, envelope } = input;
    if (!password || password.length > 256) return sendJson(response, 400, { error: 'Enter your current password to reset DM encryption.' });
    if (!Number.isSafeInteger(revision) || revision < 0) return sendJson(response, 400, { error: 'Refresh Glean and try the key reset again.' });
    if (!publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256'
      || !/^[A-Za-z0-9_-]{43}$/.test(publicKey.x || '') || !/^[A-Za-z0-9_-]{43}$/.test(publicKey.y || '')) {
      return sendJson(response, 400, { error: 'Invalid new encryption key.' });
    }
    const computedFingerprint = publicKeyFingerprint(publicKey);
    if (typeof fingerprint !== 'string' || fingerprint.toLowerCase() !== computedFingerprint) {
      return sendJson(response, 400, { error: 'Encryption key fingerprint does not match the new key.' });
    }
    if (!envelope || envelope.version !== 1 || !/^[A-Za-z0-9_-]{16}$/.test(envelope.iv || '')
      || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length < 22 || envelope.ciphertext.length > 48_000
      || !/^[A-Za-z0-9_-]+$/.test(envelope.ciphertext)) {
      return sendJson(response, 400, { error: 'Invalid encrypted key backup.' });
    }

    const userRow = findUserById.get(Number(account.id));
    if (!userRow) return sendJson(response, 401, { error: 'Not signed in.' });
    const submittedHash = Buffer.from(hashPassword(password, userRow.password_salt), 'hex');
    const storedHash = Buffer.from(userRow.password_hash, 'hex');
    if (submittedHash.length !== storedHash.length || !timingSafeEqual(submittedHash, storedHash)) {
      return sendJson(response, 401, { error: 'That password is incorrect.' });
    }

    const accountKeyBackup = input.accountKeyBackup;
    const isNuper = String(account.username || '').toLowerCase() === 'nuper';
    if (isNuper && input.deleteDirectMessages !== true) return sendJson(response, 400, { error: 'Confirm that direct-message history should be deleted before resetting the account DM key.' });
    if (input.deleteDirectMessages === true && !isNuper) return sendJson(response, 403, { error: 'Only the Nuper account can use the full DM reset.' });
    const previousProfileBackup = readProfileKeyBackup.get(account.id);
    if (isNuper && !accountKeyBackup) return sendJson(response, 400, { error: 'Refresh Glean before resetting your DM key so new devices can restore it.' });
    if (accountKeyBackup && (!Number.isSafeInteger(accountKeyBackup.revision) || accountKeyBackup.revision < 0
      || !publicKeyMatchesStored(accountKeyBackup.publicKey, JSON.stringify(publicKey), computedFingerprint)
      || String(accountKeyBackup.fingerprint || '').toLowerCase() !== computedFingerprint
      || !validAccountKeyBackup(accountKeyBackup.backup))) return sendJson(response, 400, { error: 'Invalid encrypted account DM key backup.' });
    if (accountKeyBackup && Number(previousProfileBackup?.revision || 0) !== accountKeyBackup.revision) return sendJson(response, 409, { error: 'The account DM key backup changed. Refresh and retry.' });

    const encodedEnvelope = JSON.stringify({ version: 1, iv: envelope.iv, ciphertext: envelope.ciphertext });
    const encodedAccountKeyBackup = accountKeyBackup ? JSON.stringify(accountKeyBackup.backup) : null;
    const encodedPublicKey = JSON.stringify(publicKey);
    const previousFingerprint = storedPublicKeyFingerprint(userRow.public_key_jwk, userRow.key_fingerprint);
    const previousVaultFingerprint = storedPublicKeyFingerprint(readSyncVault.get(account.id)?.active_public_key);
    const changed = [previousFingerprint, previousVaultFingerprint].some((value) => value && value !== computedFingerprint);
    const dmAttachmentStorage = input.deleteDirectMessages === true ? listDirectMessageUploadsForUser.all(account.id).map((row) => row.storage_name) : [];
    const dmPeerIds = input.deleteDirectMessages === true ? listConversationPeerIdsForUser.all(account.id, account.id).map((row) => Number(row.user_id)) : [];
    try {
      withTransaction(() => {
        const previousVault = readSyncVault.get(account.id);
        const currentRevision = Number(previousVault?.revision || 0);
        if (currentRevision !== revision) {
          const conflict = new Error('Your encryption keys changed in another tab. Refresh and try again.');
          conflict.code = 'E2EE_RESET_CONFLICT';
          throw conflict;
        }
        if (previousVault) {
          const oldKey = safeJsonParse(previousVault.active_public_key);
          archiveSyncVault.run(account.id, storedPublicKeyFingerprint(previousVault.active_public_key), previousVault.active_public_key, previousVault.envelope, now);
          if (!oldKey) throw new Error('The existing encryption key record is invalid; it was not changed.');
        } else if (userRow.public_key_jwk) {
          archiveSyncVault.run(account.id, previousFingerprint, userRow.public_key_jwk, null, now);
        }
        const result = previousVault
          ? replaceSyncVault.run(encodedEnvelope, encodedPublicKey, account.id, revision)
          : createSyncVault.run(account.id, encodedEnvelope, encodedPublicKey);
        if (!result.changes) {
          const conflict = new Error('Your encryption keys changed in another tab. Refresh and try again.');
          conflict.code = 'E2EE_RESET_CONFLICT';
          throw conflict;
        }
        updateUserPublicKey.run(encodedPublicKey, computedFingerprint, account.id);
        if (accountKeyBackup) {
          const backupResult = accountKeyBackup.revision === 0
            ? createProfileKeyBackup.run(account.id, encodedAccountKeyBackup, now)
            : replaceProfileKeyBackup.run(encodedAccountKeyBackup, now, account.id, accountKeyBackup.revision);
          if (!backupResult.changes) {
            const conflict = new Error('The account DM key backup changed. Refresh and retry.');
            conflict.code = 'E2EE_PROFILE_BACKUP_CONFLICT';
            throw conflict;
          }
        }
        // This operation is intentionally limited to direct conversations. Server
        // channels/messages and all non-DM account data are outside this transaction.
        if (input.deleteDirectMessages === true) {
          deleteDirectConversationsForUser.run(account.id);
          deleteDirectMessagePinsForUser.run(account.id);
        }
      });
    } catch (error) {
      if (error.code === 'E2EE_RESET_CONFLICT') return sendJson(response, 409, { error: error.message });
      if (error.code === 'E2EE_PROFILE_BACKUP_CONFLICT') return sendJson(response, 409, { error: error.message });
      throw error;
    }

    removeStoredUploads(dmAttachmentStorage);

    if (changed) {
      for (const peerId of dmPeerIds) sendEvent(peerId, 'key-changed', { userId: Number(account.id), fingerprint: computedFingerprint });
    }
    return sendJson(response, 200, { ok: true, revision: revision + 1, fingerprint: computedFingerprint, directMessagesDeleted: input.deleteDirectMessages === true });
  }

  if (path === '/api/e2ee/profile-key' && ['GET', 'PUT'].includes(method)) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    if (String(user.username || '').toLowerCase() !== 'nuper') return sendJson(response, 404, { error: 'Account DM backup not found.' });
    if (method === 'GET') {
      const row = findUserById.get(user.id);
      const backup = readProfileKeyBackup.get(user.id);
      let publicKey = null;
      try { publicKey = JSON.parse(String(row?.public_key_jwk || '')) || null; } catch { publicKey = null; }
      return sendJson(response, 200, {
        revision: Number(backup?.revision || 0),
        backup: backup ? safeJsonParse(backup.backup) : null,
        publicKey,
        fingerprint: publicKey ? storedPublicKeyFingerprint(row?.public_key_jwk, row?.key_fingerprint) : null,
      });
    }
    const retry = takeRateLimit(request, `e2ee-profile-key:${user.id}`, 20, 60_000);
    if (retry) return sendJson(response, 429, { error: 'Too many account-key backup attempts.' }, { 'Retry-After': String(retry) });
    let input;
    try { input = await readJson(request, 100_000); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    const { revision, publicKey, fingerprint, backup } = input;
    if (!Number.isSafeInteger(revision) || revision < 0 || !publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256'
      || !/^[A-Za-z0-9_-]{43}$/.test(publicKey.x || '') || !/^[A-Za-z0-9_-]{43}$/.test(publicKey.y || '')
      || !validAccountKeyBackup(backup)) return sendJson(response, 400, { error: 'Invalid encrypted account-key backup.' });
    const computedFingerprint = publicKeyFingerprint(publicKey);
    if (typeof fingerprint !== 'string' || fingerprint.toLowerCase() !== computedFingerprint) return sendJson(response, 400, { error: 'Account-key fingerprint does not match.' });
    const current = findUserById.get(user.id);
    const currentFingerprint = storedPublicKeyFingerprint(current?.public_key_jwk, current?.key_fingerprint);
    if (currentFingerprint && currentFingerprint !== computedFingerprint) return sendJson(response, 409, { error: 'This device does not have the active Glean message key.' });
    const previous = readProfileKeyBackup.get(user.id);
    if (Number(previous?.revision || 0) !== revision) return sendJson(response, 409, { error: 'The account key backup changed on another device. Sign in again and retry.' });
    const encodedBackup = JSON.stringify(backup);
    try {
      withTransaction(() => {
        const latestUser = findUserById.get(user.id);
        const latestFingerprint = storedPublicKeyFingerprint(latestUser?.public_key_jwk, latestUser?.key_fingerprint);
        if (latestFingerprint && latestFingerprint !== computedFingerprint) throw Object.assign(new Error('This device does not have the active Glean message key.'), { code: 'E2EE_PROFILE_KEY_MISMATCH' });
        const latestBackup = readProfileKeyBackup.get(user.id);
        if (Number(latestBackup?.revision || 0) !== revision) throw Object.assign(new Error('The account key backup changed on another device. Sign in again and retry.'), { code: 'E2EE_PROFILE_BACKUP_CONFLICT' });
        if (!latestFingerprint) updateUserPublicKey.run(JSON.stringify(publicKey), computedFingerprint, user.id);
        const result = revision === 0
          ? createProfileKeyBackup.run(user.id, encodedBackup, now)
          : replaceProfileKeyBackup.run(encodedBackup, now, user.id, revision);
        if (!result.changes) throw Object.assign(new Error('The account key backup changed on another device. Sign in again and retry.'), { code: 'E2EE_PROFILE_BACKUP_CONFLICT' });
      });
    } catch (error) {
      if (['E2EE_PROFILE_KEY_MISMATCH', 'E2EE_PROFILE_BACKUP_CONFLICT'].includes(error.code)) return sendJson(response, 409, { error: error.message });
      throw error;
    }
    return sendJson(response, 200, { ok: true, revision: revision + 1 });
  }

  if (path === '/api/e2ee/sync' && ['GET', 'PUT'].includes(method)) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    if (method === 'GET') {
      const vault = readSyncVault.get(user.id);
      return sendJson(response, 200, {
        revision: vault?.revision || 0,
        envelope: vault ? JSON.parse(vault.envelope) : null,
        publicKey: vault ? safeJsonParse(vault.active_public_key) : null,
      });
    }
    const retry = takeRateLimit(request, `e2ee-sync:${user.id}`, 60, 60_000);
    if (retry) return sendJson(response, 429, { error: 'Too many key sync attempts.' }, { 'Retry-After': String(retry) });
    const { revision, envelope, publicKey } = await readJson(request);
    if (!Number.isSafeInteger(revision) || revision < 0 || !envelope || envelope.version !== 1
      || typeof envelope.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(envelope.iv)
      || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length < 22 || envelope.ciphertext.length > 48_000
      || !/^[A-Za-z0-9_-]+$/.test(envelope.ciphertext)) return sendJson(response, 400, { error: 'Invalid encrypted key vault.' });
    const encoded = JSON.stringify({ version: 1, iv: envelope.iv, ciphertext: envelope.ciphertext });
    if (!publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256' || !/^[A-Za-z0-9_-]{43}$/.test(publicKey.x || '') || !/^[A-Za-z0-9_-]{43}$/.test(publicKey.y || '')) return sendJson(response, 400, { error: 'Invalid synced public key.' });
    const previous = readSyncVault.get(user.id);
    if (previous && publicKeyFingerprint(publicKey) !== publicKeyFingerprint(JSON.parse(previous.active_public_key))) return sendJson(response, 409, { error: 'The active synced key cannot be replaced.' });
    const result = revision === 0 ? createSyncVault.run(user.id, encoded, JSON.stringify(publicKey)) : replaceSyncVault.run(encoded, JSON.stringify(publicKey), user.id, revision);
    if (!result.changes) return sendJson(response, 409, { error: 'Keys changed on another device. Sync again.' });
    return sendJson(response, 200, { revision: revision + 1, envelope: JSON.parse(encoded) });
  }

  if (['GET', 'PUT'].includes(method) && path === '/api/e2ee/key') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    if (method === 'GET') {
      const row = findUserById.get(user.id);
      let publicKey = null;
      try { publicKey = JSON.parse(String(row?.public_key_jwk || '')) || null; } catch { publicKey = null; }
      return sendJson(response, 200, { publicKey, fingerprint: publicKey ? storedPublicKeyFingerprint(row?.public_key_jwk, row?.key_fingerprint) : null });
    }
    const { publicKey, fingerprint } = await readJson(request);
    const encoded = JSON.stringify(publicKey || {});
    if (!publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256' || typeof publicKey.x !== 'string' || typeof publicKey.y !== 'string' || encoded.length > 2048) {
      return sendJson(response, 400, { error: 'Invalid encryption public key.' });
    }
    const computedFingerprint = publicKeyFingerprint(publicKey);
    const vault = readSyncVault.get(user.id);
    if (vault && computedFingerprint !== publicKeyFingerprint(JSON.parse(vault.active_public_key))) return sendJson(response, 409, { error: 'This device does not have the active Glean message key.' });
    const existingFingerprint = storedPublicKeyFingerprint(user.public_key_jwk, user.key_fingerprint);
    if (existingFingerprint && computedFingerprint !== existingFingerprint) return sendJson(response, 409, { error: 'This device does not have the active Glean message key. Sign in on a device that can read your DMs to restore your account key.' });
    if (fingerprint && String(fingerprint).toLowerCase() !== computedFingerprint) return sendJson(response, 400, { error: 'Encryption key fingerprint does not match the public key.' });
    const previousFingerprint = storedPublicKeyFingerprint(user.public_key_jwk, user.key_fingerprint);
    const changed = Boolean(user.public_key_jwk && previousFingerprint && previousFingerprint !== computedFingerprint);
    updateUserPublicKey.run(encoded, computedFingerprint, user.id);
    if (changed) {
      for (const conversation of listConversations.all(user.id, user.id)) {
        sendEvent(conversation.user_id, 'key-changed', { userId: Number(user.id), fingerprint: computedFingerprint });
      }
    }
    return sendJson(response, 200, { ok: true, changed, fingerprint: computedFingerprint });
  }

  if (method === 'POST' && path === '/api/account/bio') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const { bio } = await readJson(request);
    if (typeof bio !== 'string' || bio.length > 500) return sendJson(response, 400, { error: 'Your bio can be up to 500 characters.' });
    updateBio.run(bio.trim(), user.id);
    return sendJson(response, 200, { account: publicAccount({ ...user, bio: bio.trim() }) });
  }

  if (method === 'POST' && path === '/api/account/custom-badges') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const payload = await readJson(request);
    const badges = normalizeCustomBadges(payload.customBadges);
    if (!badges) return sendJson(response, 400, { error: 'Add up to 8 badges. Each needs unique text of 1–20 characters and a valid color.' });
    const stored = JSON.stringify(badges);
    updateCustomBadges.run(stored, user.id);
    return sendJson(response, 200, { account: publicAccount({ ...user, custom_badges_json: stored }) });
  }

  if (method === 'POST' && path === '/api/account/grade') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const { grade } = await readJson(request);
    const cleanGrade = publicGrade(grade);
    if (!cleanGrade) return sendJson(response, 400, { error: 'Choose a grade option to continue.' });
    updateGrade.run(cleanGrade, user.id);
    let nextSchool = publicSchool(user.school);
    if (nextSchool && !schoolFitsGrade(nextSchool, cleanGrade)) {
      updateSchool.run(null, user.id);
      nextSchool = null;
    }
    return sendJson(response, 200, { account: publicAccount({ ...user, grade: cleanGrade, school: nextSchool }) });
  }

  if (method === 'POST' && path === '/api/account/school') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const { school } = await readJson(request);
    const cleanSchool = publicSchool(school);
    if (!cleanSchool) return sendJson(response, 400, { error: 'Choose a school option to continue.' });
    const grade = publicGrade(user.grade);
    if (grade && !schoolFitsGrade(cleanSchool, grade)) return sendJson(response, 400, { error: 'Choose a school that matches your grade.' });
    updateSchool.run(cleanSchool, user.id);
    return sendJson(response, 200, { account: publicAccount({ ...user, school: cleanSchool }) });
  }

  if (method === 'POST' && path === '/api/account/program') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const payload = await readJson(request);
    const encoded = encodeProgramJson(payload.programs ?? payload.program);
    if (!encoded) return sendJson(response, 400, { error: 'Pick a program, or choose “Neither in these programs”.' });
    updateProgram.run(encoded, user.id);
    return sendJson(response, 200, { account: publicAccount({ ...user, program_json: encoded }) });
  }

  if (method === 'POST' && path === '/api/account/discord') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const payload = await readJson(request);
    const raw = payload.discordUsername ?? payload.discord ?? '';
    if (raw != null && typeof raw !== 'string') return sendJson(response, 400, { error: 'Use a Discord username like name or name#0000.' });
    const clean = normalizeDiscordUsername(raw);
    if (raw.trim() && clean == null) return sendJson(response, 400, { error: 'Use a Discord username like name or name#0000.' });
    const stored = clean || null;
    updateDiscordUsername.run(stored, user.id);
    return sendJson(response, 200, { account: publicAccount({ ...user, discord_username: stored }) });
  }

  if (method === 'POST' && path === '/api/account/social-links') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const payload = await readJson(request);
    const instagram = normalizeSocialUrl(payload.instagram, 'instagram');
    const instagramUsername = normalizeSocialUsername(payload.instagramUsername, 'instagram');
    const tiktok = normalizeSocialUrl(payload.tiktok, 'tiktok');
    const tiktokUsername = normalizeSocialUsername(payload.tiktokUsername, 'tiktok');
    if (instagram == null || instagramUsername == null || tiktok == null || tiktokUsername == null) return sendJson(response, 400, { error: 'Use valid Instagram and TikTok usernames and links.' });
    updateSocialLinks.run(instagram || null, instagramUsername || null, tiktok || null, tiktokUsername || null, user.id);
    markSocialPromptSeen.run(user.id);
    return sendJson(response, 200, { account: publicAccount({ ...user, instagram_url: instagram || null, instagram_username: instagramUsername || null, tiktok_url: tiktok || null, tiktok_username: tiktokUsername || null, social_prompt_seen: 1 }) });
  }

  if (method === 'POST' && path === '/api/account/social-links/skip') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    markSocialPromptSeen.run(user.id);
    return sendJson(response, 200, { account: publicAccount({ ...user, social_prompt_seen: 1 }) });
  }

  if (method === 'POST' && path === '/api/account/avatar') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const formRequest = new Request(`http://${request.headers.host || 'localhost'}${request.url}`, { method: request.method, headers: request.headers, body: Readable.toWeb(request), duplex: 'half' });
    const form = await formRequest.formData();
    const file = form.get('avatar');
    const avatarTypes = new Map([['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif']]);
    const avatarExtension = file && avatarTypes.get(String(file.type || '').toLowerCase());
    if (!file || !avatarExtension || file.size > MAX_AVATAR_BYTES) return sendJson(response, 400, { error: 'Choose a JPG, PNG, WebP, or GIF up to 200 MB.' });
    const cropText = String(form.get('crop') || '');
    let gifCrop = null;
    if (cropText && avatarExtension === '.gif') {
      try {
        const parsed = JSON.parse(cropText).gifCrop;
        if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y) && Number.isFinite(parsed.size)) gifCrop = parsed;
      } catch {}
    }
    let avatarBytes = Buffer.from(await file.arrayBuffer());
    let storedExtension = avatarExtension;
    if (gifCrop) {
      const metadata = await sharp(avatarBytes, { animated: true }).metadata();
      const size = Math.max(1, Math.min(Math.floor(gifCrop.size), metadata.width || 1, metadata.height || 1));
      const left = Math.max(0, Math.min((metadata.width || size) - size, Math.floor(gifCrop.x)));
      const top = Math.max(0, Math.min((metadata.height || size) - size, Math.floor(gifCrop.y)));
      avatarBytes = await sharp(avatarBytes, { animated: true })
        .extract({ left, top, width: size, height: size })
        .rotate(Number.isFinite(gifCrop.angle) ? gifCrop.angle : 0)
        .gif({ effort: 3 })
        .toBuffer();
    }
    const storageName = `avatar-${randomBase32(18)}${storedExtension}`;
    writeFileSync(join(uploadDirectory, storageName), avatarBytes, { mode: 0o600 });
    database.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(`${apiPrefix}/avatars/${storageName}`, user.id);
    return sendJson(response, 200, { account: publicAccount({ ...user, avatar_url: `${apiPrefix}/avatars/${storageName}` }) });
  }

  if (method === 'POST' && path === '/api/account/banner') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const previous = publicBanner(user.banner_json);
    const contentType = String(request.headers['content-type'] || '');
    let next = null;
    if (contentType.startsWith('multipart/form-data')) {
      const formRequest = new Request(`http://${request.headers.host || 'localhost'}${request.url}`, { method: request.method, headers: request.headers, body: Readable.toWeb(request), duplex: 'half' });
      const file = (await formRequest.formData()).get('banner');
      const fileType = String(file?.type || '').toLowerCase();
      if (!file || !['image/jpeg', 'image/gif'].includes(fileType) || file.size > 8 * 1024 * 1024) {
        return sendJson(response, 400, { error: 'Choose a JPG or GIF up to 8 MB.' });
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      const validImage = fileType === 'image/jpeg'
        ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : isGif(bytes);
      if (!validImage) {
        return sendJson(response, 400, { error: 'Choose a valid JPG or GIF up to 8 MB.' });
      }
      const storageName = `banner-${randomBase32(18)}${fileType === 'image/gif' ? '.gif' : '.jpg'}`;
      writeFileSync(join(uploadDirectory, storageName), bytes, { mode: 0o600 });
      next = { kind: 'image', imageUrl: `${apiPrefix}/banners/${storageName}` };
    } else {
      let input;
      try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
      if (input.kind === 'none') {
        next = null;
      } else if (input.kind === 'solid') {
        next = publicBanner({ kind: 'solid', color: input.color });
        if (!next) return sendJson(response, 400, { error: 'Pick a valid color.' });
      } else if (input.kind === 'gradient') {
        next = publicBanner({ kind: 'gradient', from: input.from, to: input.to, angle: input.angle });
        if (!next) return sendJson(response, 400, { error: 'Pick two colors and a direction.' });
      } else if (input.kind === 'image') {
        const keep = publicBanner({ kind: 'image', imageUrl: input.imageUrl });
        if (!keep || keep.imageUrl !== previous?.imageUrl) return sendJson(response, 400, { error: 'Upload a photo to use as your banner.' });
        next = keep;
      } else {
        return sendJson(response, 400, { error: 'Pick a color, gradient, or photo.' });
      }
    }
    const oldName = bannerFileName(previous);
    const newName = bannerFileName(next);
    updateBanner.run(next ? JSON.stringify(next) : null, user.id);
    if (oldName && oldName !== newName) removeStoredUploads([oldName]);
    return sendJson(response, 200, { account: publicAccount({ ...user, banner_json: next ? JSON.stringify(next) : null }) });
  }

  if (method === 'POST' && path === '/api/account/profile-background') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    let next = null;
    if (String(request.headers['content-type'] || '').startsWith('multipart/form-data')) {
      const retryAfter = takeRateLimit(request, `profile-background:${user.id}`, 10, 60_000);
      if (retryAfter) return sendJson(response, 429, { error: 'Too many uploads. Try again shortly.' }, { 'Retry-After': String(retryAfter) });
      let uploaded;
      try { uploaded = await readProfileBackgroundImage(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
      const storageName = `profile-background-${randomBase32(18)}.jpg`;
      writeFileSync(join(uploadDirectory, storageName), uploaded.bytes, { mode: 0o600 });
      next = { kind: 'image', imageUrl: `${apiPrefix}/profile-backgrounds/${storageName}`, ...uploaded.adjustments };
    } else {
      let input;
      try { input = await readJson(request, 2048); } catch (error) { return sendJson(response, 400, { error: error.message }); }
      if (input.kind === 'none') {
        next = null;
      } else if (input.kind === 'solid') {
        next = publicProfileBackground({ kind: 'solid', color: input.color });
        if (!next) return sendJson(response, 400, { error: 'Pick a valid color.' });
      } else if (input.kind === 'gradient') {
        next = publicProfileBackground({ kind: 'gradient', from: input.from, to: input.to, angle: input.angle });
        if (!next) return sendJson(response, 400, { error: 'Pick two colors and a direction.' });
      } else if (input.kind === 'image') {
        const adjustments = profileImageAdjustments(input, true);
        if (!adjustments) return sendJson(response, 400, { error: 'Contrast and saturation must be 0–200%. Blur must be 0–100px.' });
        const current = publicProfileBackground(findUserById.get(user.id)?.profile_background_json);
        if (typeof input.imageUrl !== 'string' || !PROFILE_BACKGROUND_URL.test(input.imageUrl) || input.imageUrl !== current?.imageUrl) return sendJson(response, 400, { error: 'Upload a photo to use as your profile background.' });
        next = { kind: 'image', imageUrl: input.imageUrl, ...adjustments };
      } else {
        return sendJson(response, 400, { error: 'Pick a solid color, gradient, or image.' });
      }
    }
    const latestUser = findUserById.get(user.id);
    const previous = publicProfileBackground(latestUser?.profile_background_json);
    const oldName = previous?.imageUrl?.match(PROFILE_BACKGROUND_URL)?.[1];
    const newName = next?.imageUrl?.match(PROFILE_BACKGROUND_URL)?.[1];
    if (!latestUser) {
      if (newName) removeStoredUploads([newName]);
      return sendJson(response, 401, { error: 'Not signed in.' });
    }
    try { updateProfileBackground.run(next ? JSON.stringify(next) : null, user.id); } catch (error) {
      if (newName && newName !== oldName) removeStoredUploads([newName]);
      throw error;
    }
    if (oldName && oldName !== newName) removeStoredUploads([oldName]);
    return sendJson(response, 200, { account: publicAccount({ ...latestUser, profile_background_json: next ? JSON.stringify(next) : null }) });
  }

  const backgroundMatch = path.match(/^\/api\/profile-backgrounds\/(profile-background-[a-z2-7]+\.jpg)$/);
  if (['GET', 'HEAD'].includes(method) && backgroundMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const name = backgroundMatch[1];
    const owner = database.prepare("SELECT id FROM users WHERE json_extract(profile_background_json, '$.imageUrl') = ?").get(`${apiPrefix}/profile-backgrounds/${name}`);
    const filePath = join(uploadDirectory, name);
    if (!owner || !existsSync(filePath)) return sendJson(response, 404, { error: 'Profile background not found.' });
    return sendLocalFile(request, response, filePath, { type: 'image/jpeg', extra: { 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
  }

  if ((method === 'POST' || method === 'PATCH') && path === '/api/account/name-style') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    let next = null;
    if (input.kind !== 'none') {
      next = publicNameStyle(input);
      if (!next && (input.kind || input.color || input.from || input.to || input.font || input.glow)) {
        return sendJson(response, 400, { error: 'Pick a valid color, gradient, glow, or font.' });
      }
    }
    updateNameStyle.run(next ? JSON.stringify(next) : null, user.id);
    return sendJson(response, 200, { account: publicAccount({ ...user, name_style_json: next ? JSON.stringify(next) : null }) });
  }

  const avatarMatch = path.match(/^\/api\/avatars\/([a-z0-9._-]+)$/i);
  if (method === 'GET' && avatarMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const owner = database.prepare('SELECT id, avatar_url FROM users WHERE avatar_url = ? OR avatar_url = ?').get(`${apiPrefix}/avatars/${avatarMatch[1]}`, `/api/avatars/${avatarMatch[1]}`);
    if (!owner) return sendJson(response, 404, { error: 'Avatar not found.' });
    const filePath = join(uploadDirectory, avatarMatch[1]);
    if (!existsSync(filePath)) return sendJson(response, 404, { error: 'Avatar not found.' });
    return sendLocalFile(request, response, filePath, { type: imageMimeType(avatarMatch[1]), extra: { 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
  }

  const bannerMatch = path.match(/^\/api\/banners\/(banner-[a-z2-7]+\.(?:jpg|gif))$/i);
  if (method === 'GET' && bannerMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const name = bannerMatch[1].toLowerCase();
    if (!BANNER_FILE.test(name)) return sendJson(response, 404, { error: 'Banner not found.' });
    const owner = database.prepare(`SELECT id FROM users WHERE json_extract(banner_json, '$.kind') = 'image' AND (json_extract(banner_json, '$.imageUrl') = ? OR json_extract(banner_json, '$.imageUrl') = ?)`).get(`${apiPrefix}/banners/${name}`, `/api/banners/${name}`);
    if (!owner) return sendJson(response, 404, { error: 'Banner not found.' });
    const filePath = join(uploadDirectory, name);
    if (!existsSync(filePath)) return sendJson(response, 404, { error: 'Banner not found.' });
    return sendLocalFile(request, response, filePath, {
      type: imageMimeType(name),
      extra: { 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  if (path.startsWith('/api/apps/') || path.startsWith('/api/app-images/')) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const handled = await appService.handleRequest({
      method, path, request, response, user, sendJson, readJson, formFile: readSingleUpload,
    });
    if (handled !== false) return;
  }

  if (method === 'GET' && path === '/api/events') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write('event: connected\ndata: {}\n\n');
    const clients = eventClients.get(user.id) || new Set();
    clients.add(response);
    eventClients.set(user.id, clients);
    const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 25_000);
    request.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(response);
      if (!clients.size) eventClients.delete(user.id);
    });
    return;
  }

  const typingMatch = path.match(/^\/api\/conversations\/(\d+)\/typing$/);
  if (method === 'POST' && typingMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    if (Boolean(Number(user.keep_information_secret))) return sendJson(response, 200, { ok: true, suppressed: true });
    const conversationId = Number(typingMatch[1]);
    if (!isConversationMember.get(conversationId, user.id)) return sendJson(response, 404, { error: 'Conversation not found.' });
    const typingPeer = findConversationPeer.get(conversationId, user.id);
    if (typingPeer && isBlockedEither(user.id, typingPeer.id)) return sendJson(response, 403, { error: "You can't message this person." });
    const { typing } = await readJson(request);
    for (const member of listConversationMemberIds.all(conversationId)) if (member.user_id !== user.id) sendEvent(member.user_id, 'typing', { conversationId, userId: Number(user.id), username: user.username, typing: typing === true });
    return sendJson(response, 200, { ok: true });
  }

  if (method === 'GET' && path === '/api/friends') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    return sendJson(response, 200, {
      friends: listFriends.all(user.id, user.id, user.id).map((friend) => ({ id: Number(friend.id), username: friend.username, verified: Number(friend.is_verified) === 1, avatarUrl: friend.avatar_url || null, nameStyle: publicNameStyle(friend.name_style_json), isBot: Boolean(Number(friend.is_bot)), presence: Number(friend.is_bot) ? 'online' : publicPresence(friend.id) })),
      requests: listIncomingRequests.all(user.id).map((friendRequest) => ({
        id: Number(friendRequest.id), user: { id: Number(friendRequest.user_id), username: friendRequest.username, verified: Number(friendRequest.is_verified) === 1, avatarUrl: friendRequest.avatar_url || null, nameStyle: publicNameStyle(friendRequest.name_style_json), presence: publicPresence(friendRequest.user_id) }, createdAt: friendRequest.created_at,
      })),
      sent: listOutgoingRequests.all(user.id).map((friendRequest) => ({
        id: Number(friendRequest.id), user: { id: Number(friendRequest.user_id), username: friendRequest.username, verified: Number(friendRequest.is_verified) === 1, avatarUrl: friendRequest.avatar_url || null, nameStyle: publicNameStyle(friendRequest.name_style_json), presence: publicPresence(friendRequest.user_id) }, createdAt: friendRequest.created_at,
      })),
    });
  }

  if (method === 'GET' && path === '/api/analytics') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    return sendJson(response, 200, { analytics: buildCommunityAnalytics() });
  }

  if (method === 'GET' && path === '/api/analytics/people') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const params = new URL(request.url, 'http://localhost').searchParams;
    const cursorValue = Number(params.get('cursor') || 0);
    const requestedLimit = Number(params.get('limit') || 50);
    const query = String(params.get('query') || '').trim().slice(0, 80);
    if (!Number.isSafeInteger(cursorValue) || cursorValue < 0 || !Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
      return sendJson(response, 400, { error: 'Invalid analytics people pagination.' });
    }
    const rows = listAnalyticsPeople.all(cursorValue, query, requestedLimit + 1);
    const hasMore = rows.length > requestedLimit;
    const page = rows.slice(0, requestedLimit);
    return sendJson(response, 200, {
      people: page.map((person) => {
        const grade = publicGrade(person.grade);
        const school = publicSchool(person.school);
        return {
          id: Number(person.id),
          username: person.username,
          verified: Number(person.is_verified) === 1,
          avatarUrl: person.avatar_url || null,
          grade,
          gradeLabel: gradeLabel(grade),
          school,
          schoolLabel: schoolBadgeLabel(school),
          programs: publicPrograms(person.program_json),
          badges: publicUserBadges(person),
          joinedAt: person.created_at,
        };
      }),
      nextCursor: hasMore ? Number(page.at(-1).id) : null,
    });
  }

  if (method === 'GET' && path === '/api/people') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const search = new URL(request.url, `http://${request.headers.host || 'localhost'}`).searchParams;
    const cursor = Number(search.get('cursor') || 0);
    const requestedLimit = Number(search.get('limit') || 500);
    const query = String(search.get('query') || '').trim().slice(0, 80);
    const rawSchool = String(search.get('school') || '').trim();
    const school = rawSchool ? publicSchool(rawSchool) : '';
    const rawProgram = String(search.get('program') || '').trim();
    const program = rawProgram && PROGRAMS.some((item) => item.id === rawProgram) ? rawProgram : '';
    const rawGrade = String(search.get('grade') || '').trim();
    const grade = rawGrade ? publicGrade(rawGrade) : '';
    const filter = search.get('filter') || 'all';
    const attributes = [...new Set(String(search.get('attributes') || '').split(',').filter(Boolean))];
    if (!Number.isSafeInteger(cursor) || cursor < 0) return sendJson(response, 400, { error: 'Invalid people cursor.' });
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 500) return sendJson(response, 400, { error: 'People limit must be between 1 and 500.' });
    if (rawSchool && !school) return sendJson(response, 400, { error: 'Unknown school filter.' });
    if (rawProgram && !program) return sendJson(response, 400, { error: 'Unknown program filter.' });
    if (rawGrade && !grade) return sendJson(response, 400, { error: 'Unknown grade filter.' });
    if (!['all', 'add', 'pending', 'friends'].includes(filter)) return sendJson(response, 400, { error: 'Unknown people filter.' });
    if (attributes.some(attribute => !['magnet', 'laredo-college'].includes(attribute))) return sendJson(response, 400, { error: 'Unknown school or program filter.' });
    const args = [user.id, query, school || '', program, grade || '', filter, attributes.join(',')];
    const count = countDiscoverPeople.get(...args);
    const rows = listDiscoverPeople.all(...args, cursor, requestedLimit + 1);
    const hasMore = rows.length > requestedLimit;
    const page = rows.slice(0, requestedLimit);
    return sendJson(response, 200, {
      people: page.map((person) => {
        const personGrade = publicGrade(person.grade);
        return {
          id: Number(person.id),
          username: person.username,
          verified: Number(person.is_verified) === 1,
          avatarUrl: person.avatar_url || null,
          bio: person.bio || '',
          grade: personGrade,
          gradeLabel: gradeLabel(personGrade),
          school: publicSchool(person.school),
          schoolLabel: schoolBadgeLabel(person.school),
          schoolHex: schoolHex(person.school),
          customBadges: publicCustomBadges(person.custom_badges_json),
          programs: publicPrograms(person.program_json),
          badges: publicUserBadges(person),
          relation: person.relation,
          requestId: person.request_id ? Number(person.request_id) : null,
          presence: publicPresence(person.id),
        };
      }),
      total: Number(count.matched_total || 0),
      counts: { all: Number(count.total || 0), add: Number(count.to_add || 0), friends: Number(count.friends || 0), pending: Number(count.pending || 0) },
      attributeCounts: { magnet: Number(count.magnet || 0), 'laredo-college': Number(count.laredo_college || 0) },
      nextCursor: hasMore ? Number(page.at(-1).id) : null,
    });
  }

  if (path === '/api/account/verified-users' && method === 'GET') {
    const admin = requireSignedInUser(request, response);
    if (!admin) return;
    if (!isNuperAdmin(admin)) return sendJson(response, 403, { error: 'Only the Nuper account can manage verified badges.' });
    const query = String(new URL(request.url, `http://${request.headers.host || 'localhost'}`).searchParams.get('q') || '').trim().slice(0, 80);
    const users = database.prepare(`SELECT id,username,avatar_url,is_verified FROM users
      WHERE username IS NOT NULL AND is_bot=0 AND (?='' OR instr(lower(username),lower(?))>0)
      ORDER BY is_verified DESC,username COLLATE NOCASE LIMIT 50`).all(query,query);
    return sendJson(response, 200, { users: users.map(person => ({ id:Number(person.id),username:person.username,avatarUrl:person.avatar_url || null,verified:Number(person.is_verified) === 1 })) });
  }
  const verifiedUserMatch = path.match(/^\/api\/account\/verified-users\/(\d+)$/);
  if (verifiedUserMatch && method === 'PATCH') {
    const admin = requireSignedInUser(request, response);
    if (!admin) return;
    if (!isNuperAdmin(admin)) return sendJson(response, 403, { error: 'Only the Nuper account can manage verified badges.' });
    const targetId = Number(verifiedUserMatch[1]);
    if (!Number.isSafeInteger(targetId) || targetId < 1) return sendJson(response, 400, { error: 'Choose a valid account.' });
    let input;
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    if (typeof input.verified !== 'boolean') return sendJson(response, 400, { error: 'Choose whether the account is verified.' });
    const target = findUserById.get(targetId);
    if (!target?.username || Number(target.is_bot)) return sendJson(response, 404, { error: 'That Glean account was not found.' });
    database.prepare('UPDATE users SET is_verified=? WHERE id=?').run(input.verified ? 1 : 0,targetId);
    const updated = findUserById.get(targetId);
    realtimeHub.broadcastAll('user-verification-updated', { userId:targetId,verified:input.verified });
    realtimeHub.broadcastAll('user-updated', { userId:targetId });
    return sendJson(response, 200, { user:{ id:targetId,username:updated.username,avatarUrl:updated.avatar_url || null,verified:input.verified } });
  }

  const userProfileMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (method === 'GET' && userProfileMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const username = usernameFromPathSegment(userProfileMatch[1]);
    if (!username) return sendJson(response, 404, { error: 'That Glean user was not found.' });
    const profile = findProfileByUsername.get(user.id, user.id, user.id, user.id, user.id, user.id, username);
    if (!profile) return sendJson(response, 404, { error: 'That Glean user was not found.' });
    const relation = profile.relation;
    return sendJson(response, 200, {
      user: {
        id: Number(profile.id),
        username: profile.username,
        verified: Number(profile.is_verified) === 1,
        avatarUrl: profile.avatar_url || null,
        banner: publicBanner(profile.banner_json),
        profileBackground: publicProfileBackground(profile.profile_background_json),
        nameStyle: publicNameStyle(profile.name_style_json),
        bio: profile.bio || '',
        createdAt: profile.created_at,
        grade: publicGrade(profile.grade),
        gradeLabel: gradeLabel(profile.grade),
        school: publicSchool(profile.school),
        schoolLabel: schoolBadgeLabel(profile.school),
        schoolHex: schoolHex(profile.school),
        customBadges: publicCustomBadges(profile.custom_badges_json),
        programs: publicPrograms(profile.program_json),
        badges: publicUserBadges(profile),
        discordUsername: publicDiscordUsername(profile.discord_username),
        socialLinks: { instagram: profile.instagram_url || null, instagramUsername: profile.instagram_username || null, tiktok: profile.tiktok_url || null, tiktokUsername: profile.tiktok_username || null },
        note: getUserNote.get(user.id, profile.id)?.note || '',
        relation,
        requestId: profile.request_id ? Number(profile.request_id) : null,
        platformAdmin: isPlatformAdmin(profile),
        presence: publicPresence(profile.id),
      },
    });
  }

  const userProfileNoteMatch = path.match(/^\/api\/users\/([^/]+)\/note$/);
  if (method === 'PATCH' && userProfileNoteMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const username = usernameFromPathSegment(userProfileNoteMatch[1]);
    if (!username) return sendJson(response, 404, { error: 'That Glean user was not found.' });
    const target = findUserByUsername.get(username);
    if (!target) return sendJson(response, 404, { error: 'That Glean user was not found.' });
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    const note = String(input.note ?? '').trim();
    if (note.length > 1000) return sendJson(response, 400, { error: 'Notes must be 1000 characters or fewer.' });
    saveUserNote.run(user.id, target.id, note, new Date().toISOString());
    return sendJson(response, 200, { note });
  }

  if (method === 'POST' && path === '/api/friends/requests') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const { username } = await readJson(request);
    const recipient = findPublicUserByUsername.get(normalizeUsername(username));
    if (!recipient) return sendJson(response, 404, { error: 'That Glean user was not found.' });
    if (recipient.id === user.id) return sendJson(response, 400, { error: 'You cannot add yourself.' });
    if (isBlockedEither(user.id, recipient.id)) return sendJson(response, 403, { error: 'Could not send that request.' });
    if (Number(recipient.is_bot) === 1) {
      insertFriendship.run(...friendshipPair(user.id, recipient.id), now);
      const conversationId = createDirectConversation(user.id, recipient.id, now);
      emitFriends(user.id, 'accepted');
      emitFriends(recipient.id, 'accepted');
      sendEvent(user.id, 'conversations', { conversationId });
      return sendJson(response, 200, { ok: true, accepted: true, conversationId, username: recipient.username });
    }
    if (areFriends(user.id, recipient.id)) return sendJson(response, 409, { error: 'You are already friends.' });
    const existing = findExistingRequest.get(user.id, recipient.id, recipient.id, user.id);
    if (existing) return sendJson(response, 409, { error: existing.receiver_id === user.id ? 'They already sent you a request.' : 'Friend request already sent.' });
    insertFriendRequest.run(user.id, recipient.id, now);
    emitFriends(user.id, 'request');
    emitFriends(recipient.id, 'request');
    pushService.notifyUsers([recipient.id], {
      kind: 'friends',
      title: user.username,
      body: 'Sent you a friend request',
      icon: user.avatar_url || '/icon-192.png',
      url: '/dms',
      tag: `friends:${user.id}`,
    }, user.id);
    return sendJson(response, 201, { ok: true });
  }

  const acceptMatch = path.match(/^\/api\/friends\/requests\/(\d+)\/accept$/);
  if (method === 'POST' && acceptMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const incoming = findIncomingRequest.get(Number(acceptMatch[1]), user.id);
    if (!incoming) return sendJson(response, 404, { error: 'That friend request is no longer available.' });
    if (isBlockedEither(user.id, incoming.sender_id)) return sendJson(response, 403, { error: 'That friend request is no longer available.' });
    const senderId = acceptFriendRequest(Number(acceptMatch[1]), user.id, now);
    if (!senderId) return sendJson(response, 404, { error: 'That friend request is no longer available.' });
    emitFriends(user.id, 'accepted');
    emitFriends(senderId, 'accepted');
    return sendJson(response, 200, { ok: true });
  }

  const declineMatch = path.match(/^\/api\/friends\/requests\/(\d+)\/decline$/);
  if (method === 'POST' && declineMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const requestId = Number(declineMatch[1]);
    const incoming = findIncomingRequest.get(requestId, user.id);
    const result = deleteIncomingRequest.run(requestId, user.id);
    if (!incoming || !result.changes) return sendJson(response, 404, { error: 'That friend request is no longer available.' });
    emitFriends(user.id, 'declined');
    emitFriends(incoming.sender_id, 'declined');
    return sendJson(response, 200, { ok: true });
  }

  const cancelMatch = path.match(/^\/api\/friends\/requests\/(\d+)$/);
  if (method === 'DELETE' && cancelMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const requestId = Number(cancelMatch[1]);
    const outgoing = findOutgoingRequest.get(requestId, user.id);
    const result = deleteOutgoingRequest.run(requestId, user.id);
    if (!outgoing || !result.changes) return sendJson(response, 404, { error: 'That sent request is no longer pending.' });
    emitFriends(user.id, 'cancelled');
    emitFriends(outgoing.receiver_id, 'cancelled');
    return sendJson(response, 200, { ok: true });
  }

  const unfriendMatch = path.match(/^\/api\/friends\/([^/]+)$/);
  if (method === 'DELETE' && unfriendMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const other = findPublicUserByUsername.get(usernameFromPathSegment(unfriendMatch[1]));
    if (!other || other.id === user.id) return sendJson(response, 404, { error: 'That Glean user was not found.' });
    if (!areFriends(user.id, other.id)) return sendJson(response, 404, { error: 'You are not friends with that user.' });
    removeFriendship(user.id, other.id);
    emitFriends(user.id, 'removed');
    emitFriends(other.id, 'removed');
    return sendJson(response, 200, { ok: true });
  }

  if (method === 'GET' && path === '/api/blocks') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    return sendJson(response, 200, {
      blocked: listBlockedUsers.all(user.id).map((person) => ({
        id: Number(person.id),
        username: person.username,
        avatarUrl: person.avatar_url || null,
      })),
    });
  }

  if (method === 'POST' && path === '/api/blocks') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const { username } = await readJson(request);
    const target = findPublicUserByUsername.get(normalizeUsername(username));
    if (!target) return sendJson(response, 404, { error: 'That Glean user was not found.' });
    if (target.id === user.id) return sendJson(response, 400, { error: 'You cannot block yourself.' });
    removeFriendship(user.id, target.id);
    insertBlock.run(user.id, target.id, now);
    emitFriends(user.id, 'blocked');
    emitFriends(target.id, 'removed');
    return sendJson(response, 200, { ok: true });
  }

  const unblockMatch = path.match(/^\/api\/blocks\/([^/]+)$/);
  if (method === 'DELETE' && unblockMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const target = findPublicUserByUsername.get(usernameFromPathSegment(unblockMatch[1]));
    if (!target) return sendJson(response, 404, { error: 'That Glean user was not found.' });
    const result = deleteBlock.run(user.id, target.id);
    if (!result.changes) return sendJson(response, 404, { error: 'That user is not blocked.' });
    emitFriends(user.id, 'unblocked');
    emitFriends(target.id, 'removed');
    return sendJson(response, 200, { ok: true });
  }

  if (method === 'GET' && path === '/api/conversations') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const direct = listConversations.all(user.id, user.id).map((conversation) => ({
      id: Number(conversation.id),
      kind: 'direct',
      user: {
        id: Number(conversation.user_id), username: conversation.username, bio: conversation.bio || '', avatarUrl: conversation.avatar_url || null,
        verified: Number(conversation.is_verified) === 1,
        verified: Number(conversation.is_verified) === 1,
        nameStyle: publicNameStyle(conversation.name_style_json),
        customBadges: publicCustomBadges(conversation.custom_badges_json),
        isBot: Boolean(Number(conversation.is_bot)),
        publicKey: safeJsonParse(conversation.public_key_jwk), keyFingerprint: conversation.key_fingerprint || null,
        presence: Number(conversation.is_bot) ? 'online' : publicPresence(conversation.user_id),
      },
      blocked: Boolean(Number(conversation.blocked)),
      lastMessage: conversation.last_message_ciphertext ? 'Message' : (conversation.last_message_body || null),
      lastEncryptedMessage: conversation.last_message_ciphertext ? {
        id: Number(conversation.preview_id), encrypted: true,
        clientMessageId: conversation.preview_client_id, sender: { id: Number(conversation.preview_sender_id) },
        crypto: { version: 1, ciphertext: conversation.last_message_ciphertext, iv: conversation.preview_iv, salt: conversation.preview_salt,
          senderPublicKey: safeJsonParse(conversation.preview_sender_key), recipientPublicKey: safeJsonParse(conversation.preview_recipient_key) }
      } : null,
      lastMessageAt: conversation.last_message_at || null,
      unreadCount: Number(conversation.unread_count || 0),
      pinned: Boolean(Number(conversation.pinned)),
    }));
    const muted = new Set(database.prepare('SELECT conversation_id FROM user_conversation_mutes WHERE user_id=?').all(user.id).map(row => Number(row.conversation_id)));
    return sendJson(response, 200, { conversations: [...direct, ...groupDms.list(user.id)].map(item => ({ ...item, muted: muted.has(Number(item.id)) })), ...homeUnread(user.id) });
  }

  if (path === '/api/conversations/groups' || /^\/api\/conversations\/\d+\/group(?:\/|$)/.test(path)) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    if (await groupDms.handle({ path, method, request, response, user, readJson, sendJson }) !== false) return;
  }

  const conversationPinMatch = path.match(/^\/api\/conversations\/(\d+)\/pin$/);
  if (method === 'PATCH' && conversationPinMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const conversationId = Number(conversationPinMatch[1]);
    if (!Number.isInteger(conversationId) || conversationId < 1 || !isConversationMember.get(conversationId, user.id)) {
      return sendJson(response, 404, { error: 'That conversation was not found.' });
    }
    const { pinned } = await readJson(request);
    if (pinned === true) setConversationPin.run(user.id, conversationId, now);
    else if (pinned === false) clearConversationPin.run(user.id, conversationId);
    else return sendJson(response, 400, { error: 'Pinned must be true or false.' });
    return sendJson(response, 200, { ok: true, pinned: pinned === true });
  }

  if (method === 'GET' && path === '/api/public-servers') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const search = new URL(request.url, `http://${request.headers.host || 'localhost'}`).searchParams;
    const query = String(search.get('query') || '').trim().slice(0, 80);
    const requestedCursor = Number(search.get('cursor') || 0);
    const requestedLimit = Number(search.get('limit') || 24);
    if (!Number.isSafeInteger(requestedCursor) || requestedCursor < 0 || requestedCursor > 100000) return sendJson(response, 400, { error: 'Invalid public server cursor.' });
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) return sendJson(response, 400, { error: 'Public server limit must be between 1 and 50.' });
    const pattern = `%${query}%`;
    const rows = listPublicServers.all(user.id, query, pattern, pattern, requestedLimit + 1, requestedCursor);
    const hasMore = rows.length > requestedLimit;
    const servers = rows.slice(0, requestedLimit).map((server) => ({
      id: Number(server.id),
      name: server.name,
      iconUrl: server.icon_url || null,
      description: server.description || '',
      memberCount: Number(server.member_count || 0),
      isMember: Boolean(Number(server.is_member)),
    }));
    return sendJson(response, 200, { servers, nextCursor: hasMore ? requestedCursor + requestedLimit : null });
  }

  if (method === 'GET' && path === '/api/servers') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const memberRows = listServers.all(user.id);
    const memberIds = new Set(memberRows.map((server) => Number(server.id)));
    const inspectingRows = showInspectServersFor(user) ? listAllServers.all().filter((server) => !memberIds.has(Number(server.id))) : [];
    const rows = [...memberRows, ...inspectingRows];
    const unread = serverRailUnreadMap(user.id);
    const mutedServerIds = new Set(listMutedServerIds.all(user.id).map((row) => Number(row.server_id)));
    const home = homeUnread(user.id);
    return sendJson(response, 200, {
      ...home,
      servers: rows.map((server) => {
        const id = Number(server.id);
        const inspecting = showInspectServersFor(user) && !memberIds.has(id);
        const counts = inspecting ? { unread: false, mentionCount: 0 } : (unread.get(id) || { unread: false, mentionCount: 0 });
        const muted = mutedServerIds.has(id);
        return { ...publicServerSummary(server), inspecting, muted, unread: muted ? false : Boolean(counts.unread), unreadCount: muted ? 0 : Number(counts.unreadCount || 0), mentionCount: muted ? 0 : Number(counts.mentionCount || 0) };
      }),
    });
  }

  const serverMuteMatch = path.match(/^\/api\/servers\/(\d+)\/mute$/);
  if (method === 'PATCH' && serverMuteMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverMuteMatch[1]);
    if (!isServerMember.get(serverId, user.id)) return sendJson(response, 403, { error: 'Join this server before changing its notifications.' });
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    if (typeof input.muted !== 'boolean') return sendJson(response, 400, { error: 'Muted must be true or false.' });
    if (!isServerMember.get(serverId, user.id)) return sendJson(response, 403, { error: 'Join this server before changing its notifications.' });
    if (input.muted) setServerMute.run(user.id, serverId, now);
    else clearServerMute.run(user.id, serverId);
    sendEvent(user.id, 'notification-settings', { serverId, muted: input.muted });
    return sendJson(response, 200, { serverId, muted: input.muted });
  }

  if (method === 'PATCH' && path === '/api/servers/order') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    const serverIds = parseIdList(input.serverIds);
    if (!serverIds) return sendJson(response, 400, { error: 'Provide a unique list of server ids.' });
    const memberIds = listMemberServerIds.all(user.id).map((row) => Number(row.server_id));
    if (!sameIdSet(memberIds, serverIds)) return sendJson(response, 400, { error: 'Server order must include every server you belong to.' });
    const writeOrder = () => {
      serverIds.forEach((serverId, index) => updateMemberSortOrder.run(index, serverId, user.id));
    };
    withTransaction(writeOrder);
    return sendJson(response, 200, { ok: true, serverIds });
  }

  if (method === 'POST' && path === '/api/servers') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const { name } = await readJson(request);
    const cleanName = String(name || '').trim().replace(/\s+/g, ' ');
    if (cleanName.length < 2 || cleanName.length > 60) return sendJson(response, 400, { error: 'Server name must be 2–60 characters.' });
    const result = insertServer.run(cleanName, user.id, now);
    const serverId = Number(result.lastInsertRowid);
    const role = insertRole.run(serverId, 'Owner', '#f1c40f', 'owner', 100);
    insertRole.run(serverId, 'Moderator', '#5865f2', 'moderator', 50);
    insertRole.run(serverId, 'Member', '#99aab5', 'member', 0);
    insertMember.run(serverId, user.id, Number(role.lastInsertRowid), now, Number(nextMemberSortOrder.get(user.id).next));
    const channel = insertChannel.run(serverId, 'general', 0);
    writeServerAudit(serverId, user, 'server.created', { targetType: 'server', targetId: serverId, targetName: cleanName });
    initChannelReadsForMember(serverId, user.id);
    return sendJson(response, 201, { server: { ...publicServerSummary(findServerById.get(serverId)), channels: [{ id: Number(channel.lastInsertRowid), name: 'general', kind: 'text', voice: false, locked: false, slowmode: 0, topic: '', position: 0 }] } });
  }

  const serverInviteMatch = path.match(/^\/api\/servers\/(\d+)\/invites$/);
  if (serverInviteMatch && (method === 'GET' || method === 'POST')) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverInviteMatch[1]);
    if (!canServerPermission(user, serverId, 'manageInvites')) return sendJson(response, 403, { error: 'Manage invites permission required.' });
    if (method === 'GET') {
      return sendJson(response, 200, {
        invites: listServerInvites.all(serverId).map((invite) => ({
          code: invite.code,
          createdAt: invite.created_at,
          expiresAt: invite.expires_at,
          maxUses: Number(invite.max_uses),
          uses: Number(invite.uses),
          createdBy: invite.creator_username || null,
        })),
      });
    }
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    const invite = createInviteRecord(serverId, user.id, now, input);
    if (!invite) return sendJson(response, 503, { error: 'Unable to create an invite right now.' });
    writeServerAudit(serverId, user, 'invite.created', { targetType: 'server', targetId: serverId, targetName: findServerById.get(serverId)?.name || '', details: { expiresAt: invite.expiresAt, maxUses: invite.maxUses } });
    return sendJson(response, 201, { invite });
  }

  const serverInviteSendMatch = path.match(/^\/api\/servers\/(\d+)\/invites\/send$/);
  if (method === 'POST' && serverInviteSendMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverInviteSendMatch[1]);
    if (!canServerPermission(user, serverId, 'manageInvites')) return sendJson(response, 403, { error: 'Manage invites permission required.' });
    const server = findServerById.get(serverId);
    if (!server) return sendJson(response, 404, { error: 'Server not found.' });
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    const friend = findPublicUserByUsername.get(normalizeUsername(input.username));
    if (!friend || Number(friend.id) === Number(user.id)) return sendJson(response, 404, { error: 'That Glean user was not found.' });
    if (!areFriends(user.id, friend.id)) return sendJson(response, 403, { error: 'You can only invite accepted friends.' });
    if (isBlockedEither(user.id, friend.id)) return sendJson(response, 403, { error: "You can't message this person." });
    const invite = createInviteRecord(serverId, user.id, now, input);
    if (!invite) return sendJson(response, 503, { error: 'Unable to create an invite right now.' });
    const conversationId = createDirectConversation(user.id, friend.id, now);
    writeServerAudit(serverId, user, 'invite.sent', { targetType: 'member', targetId: friend.id, targetName: friend.username });
    const result = insertMessage.run(conversationId, user.id, `/invite/${invite.code}`, null, null, null, null, null, null, 0, now, null);
    const messageId = Number(result.lastInsertRowid);
    markConversationRead.run(messageId, messageId, conversationId, user.id);
    const message = directMessagePayload(loadDirectMessageRow.get(messageId));
    notifyDirectMessage(conversationId, message, user.id);
    sendEvent(user.id, 'conversations', { conversationId });
    sendEvent(friend.id, 'conversations', { conversationId });
    pushConversationMembers(conversationId, {
      kind: 'dm',
      title: user.username,
      body: `Invited you to ${server.name}`,
      icon: user.avatar_url || '/icon-192.png',
      url: `/dms?c=${conversationId}`,
      tag: `dm:${conversationId}`,
      conversationId,
    }, user.id);
    return sendJson(response, 201, { invite, conversationId, message });
  }

  const inviteIconMatch = path.match(/^\/api\/invites\/([A-Za-z0-9_-]{6,32})\/icon$/);
  if (method === 'GET' && inviteIconMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const invite = findInviteByCode(inviteIconMatch[1]);
    if (!invite) return sendJson(response, 404, { error: 'Invite not found.' });
    const server = findServerById.get(invite.server_id);
    const name = serverIconFileName(server?.icon_url);
    if (!name) return sendJson(response, 404, { error: 'Server photo not found.' });
    const filePath = join(uploadDirectory, name);
    if (!existsSync(filePath)) return sendJson(response, 404, { error: 'Server photo not found.' });
    return sendLocalFile(request, response, filePath, {
      type: 'image/jpeg',
      extra: { 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  const inviteBannerMatch = path.match(/^\/api\/invites\/([A-Za-z0-9_-]{6,32})\/banner$/);
  if (method === 'GET' && inviteBannerMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const invite = findInviteByCode(inviteBannerMatch[1]);
    if (!invite) return sendJson(response, 404, { error: 'Invite not found.' });
    const server = findServerById.get(invite.server_id);
    const name = bannerFileName(publicServerBanner(server?.banner_json));
    if (!name) return sendJson(response, 404, { error: 'Server banner not found.' });
    const filePath = join(uploadDirectory, name);
    if (!existsSync(filePath)) return sendJson(response, 404, { error: 'Server banner not found.' });
    return sendLocalFile(request, response, filePath, {
      type: 'image/jpeg',
      extra: { 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  const invitePreviewMatch = path.match(/^\/api\/invites\/([A-Za-z0-9_-]{6,32})$/);
  if (method === 'GET' && invitePreviewMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const invite = findInviteByCode(invitePreviewMatch[1]);
    if (!invite) return sendJson(response, 404, { error: 'That invite is invalid or has been revoked.' });
    const preview = invitePreviewFor(invite, user, now, request);
    if (!preview) return sendJson(response, 404, { error: 'Server not found.' });
    return sendJson(response, 200, preview);
  }

  const joinInviteMatch = path.match(/^\/api\/invites\/([A-Za-z0-9_-]{6,32})\/join$/);
  if (method === 'POST' && joinInviteMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const code = joinInviteMatch[1];
    const invite = findInviteByCode(code);
    if (!invite || invite.expires_at <= now || (invite.max_uses > 0 && invite.uses >= invite.max_uses)) return sendJson(response, 410, { error: 'That invite is expired or has reached its use limit.' });
    if (isServerBanned.get(invite.server_id, user.id)) return sendJson(response, 403, { error: 'You are banned from this server.' });
    const deviceHash = serverDeviceHash(request, invite.server_id);
    if (deviceHash && isServerDeviceBanned.get(invite.server_id, deviceHash)) return sendJson(response, 403, { error: 'This Glean installation is banned from this server.' });
    const server = findServerById.get(invite.server_id);
    if (!server) return sendJson(response, 404, { error: 'Server not found.' });
    if (isServerMember.get(invite.server_id, user.id)) {
      if (deviceHash) recordServerMemberDevice.run(invite.server_id, user.id, deviceHash, now, now);
      return sendJson(response, 200, { server: { ...publicServerSummary(server), alreadyMember: true } });
    }
    const memberRole = findDefaultMemberRole.get(invite.server_id);
    if (!memberRole) return sendJson(response, 500, { error: 'This server has no member role.' });
    if (!incrementInviteUse.run(invite.code).changes) return sendJson(response, 410, { error: 'That invite is expired or has reached its use limit.' });
    try {
      insertMember.run(invite.server_id, user.id, memberRole.id, now, Number(nextMemberSortOrder.get(user.id).next));
      initChannelReadsForMember(invite.server_id, user.id);
      if (deviceHash) recordServerMemberDevice.run(invite.server_id, user.id, deviceHash, now, now);
    } catch (error) {
      decrementInviteUse.run(invite.code);
      if (String(error.message).includes('UNIQUE')) return sendJson(response, 200, { server: { ...publicServerSummary(server), alreadyMember: true } });
      throw error;
    }
    if (officialAnnouncements.isServer(invite.server_id)) officialAnnouncements.clearKick(user.id);
    writeServerAudit(invite.server_id, user, 'member.joined', { targetType: 'member', targetId: user.id, targetName: user.username });
    sendEvent(user.id, 'server-membership', { serverId: Number(server.id), action: 'joined' });
    notifyServerMembers(invite.server_id, 'server-updated', { serverId: Number(server.id), action: 'member-joined' });
    return sendJson(response, 201, { server: publicServerSummary(server) });
  }

  const publicServerJoinMatch = path.match(/^\/api\/public-servers\/(\d+)\/join$/);
  if (method === 'POST' && publicServerJoinMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(publicServerJoinMatch[1]);
    const server = findServerById.get(serverId);
    if (!server || Number(server.is_public) !== 1) return sendJson(response, 404, { error: 'Public server not found.' });
    if (isServerBanned.get(serverId, user.id)) return sendJson(response, 403, { error: 'You are banned from this server.' });
    const deviceHash = serverDeviceHash(request, serverId);
    if (deviceHash && isServerDeviceBanned.get(serverId, deviceHash)) return sendJson(response, 403, { error: 'This Glean installation is banned from this server.' });
    if (isServerMember.get(serverId, user.id)) {
      if (deviceHash) recordServerMemberDevice.run(serverId, user.id, deviceHash, now, now);
      return sendJson(response, 200, { server: { ...publicServerSummary(server), alreadyMember: true } });
    }
    const memberRole = findDefaultMemberRole.get(serverId);
    if (!memberRole) return sendJson(response, 500, { error: 'This server has no member role.' });
    try {
      insertMember.run(serverId, user.id, memberRole.id, now, Number(nextMemberSortOrder.get(user.id).next));
      initChannelReadsForMember(serverId, user.id);
      if (deviceHash) recordServerMemberDevice.run(serverId, user.id, deviceHash, now, now);
    } catch (error) {
      if (String(error.message).includes('UNIQUE') && isServerMember.get(serverId, user.id)) {
        return sendJson(response, 200, { server: { ...publicServerSummary(server), alreadyMember: true } });
      }
      throw error;
    }
    if (officialAnnouncements.isServer(serverId)) officialAnnouncements.clearKick(user.id);
    writeServerAudit(serverId, user, 'member.joined', { targetType: 'member', targetId: user.id, targetName: user.username, details: { joinMethod: 'public-discovery' } });
    sendEvent(user.id, 'server-membership', { serverId, action: 'joined' });
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'member-joined' });
    return sendJson(response, 201, { server: publicServerSummary(server) });
  }

  const serverAuditMatch = path.match(/^\/api\/servers\/(\d+)\/audit-log$/);
  if (method === 'GET' && serverAuditMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverAuditMatch[1]);
    if (!canServerPermission(user, serverId, 'viewAuditLog')) return sendJson(response, 403, { error: 'View audit log permission required.' });
    const query = new URL(request.url, `http://${request.headers.host || 'localhost'}`).searchParams;
    const rawBefore = query.get('before');
    const before = rawBefore === null ? Number.MAX_SAFE_INTEGER : Number(rawBefore);
    const limit = Math.min(50, Math.max(1, Number.parseInt(query.get('limit') || '30', 10) || 30));
    if (!Number.isSafeInteger(before) || before < 1) return sendJson(response, 400, { error: 'Invalid audit cursor.' });
    const rows = listServerAudit.all(serverId, before, limit + 1);
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit).map((row) => ({
      id: Number(row.id), actorUserId: row.actorUserId === null ? null : Number(row.actorUserId),
      actorName: row.actorName, action: row.action, targetType: row.targetType,
      targetId: row.targetId, targetName: row.targetName, detailsJson: row.detailsJson,
      createdAt: row.createdAt,
    }));
    return sendJson(response, 200, { entries, nextCursor: hasMore ? String(entries.at(-1)?.id || '') : null });
  }

  const serverBotsMatch = path.match(/^\/api\/servers\/(\d+)\/bots$/);
  const serverBotMatch = path.match(/^\/api\/servers\/(\d+)\/bots\/([a-z0-9-]+)$/i);
  if (method === 'POST' && serverBotsMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverBotsMatch[1]);
    if (!canOwnServer(user, serverId)) return sendJson(response, 403, { error: 'Only the server owner can add bots.' });
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    const botKey = String(input.botId || '').trim().toLowerCase();
    if (botKey !== 'nura') return sendJson(response, 404, { error: 'That bot is not available.' });
    const defaultRole = findServerDefaultMemberRole.get(serverId);
    if (!defaultRole) return sendJson(response, 409, { error: 'This server has no member role for bots.' });
    const installedAt = new Date().toISOString();
    withTransaction(() => {
      installServerBot.run(serverId, botKey, NURA_USER_ID, user.id, installedAt);
      if (!isServerMember.get(serverId, NURA_USER_ID)) {
        const sortOrder = Number(nextMemberSortOrder.get(NURA_USER_ID)?.next || 0);
        insertMember.run(serverId, NURA_USER_ID, defaultRole.id, installedAt, sortOrder);
      }
    });
    writeServerAudit(serverId, user, 'bot.added', { targetType: 'bot', targetId: botKey, targetName: 'Nura' });
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'bot-added', botId: botKey });
    return sendJson(response, 200, { bots: listInstalledServerBots.all(serverId).map((bot) => ({ id: bot.id, name: bot.name, avatarUrl: bot.avatar_url || null, installedAt: bot.installed_at })) });
  }
  if (method === 'DELETE' && serverBotMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverBotMatch[1]);
    const botKey = String(serverBotMatch[2] || '').toLowerCase();
    if (!canOwnServer(user, serverId)) return sendJson(response, 403, { error: 'Only the server owner can remove bots.' });
    if (botKey !== 'nura') return sendJson(response, 404, { error: 'That bot is not installed.' });
    const installed = serverHasNura.get(serverId);
    if (!installed) return sendJson(response, 404, { error: 'Nura is not in this server.' });
    withTransaction(() => {
      uninstallServerBot.run(serverId, botKey);
      removeServerBotMember.run(serverId, NURA_USER_ID);
    });
    writeServerAudit(serverId, user, 'bot.removed', { targetType: 'bot', targetId: botKey, targetName: 'Nura' });
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'bot-removed', botId: botKey });
    return sendJson(response, 200, { bots: listInstalledServerBots.all(serverId).map((bot) => ({ id: bot.id, name: bot.name, avatarUrl: bot.avatar_url || null, installedAt: bot.installed_at })) });
  }

  const serverMatch = path.match(/^\/api\/servers\/(\d+)$/);
  const serverLeaveMatch = path.match(/^\/api\/servers\/(\d+)\/leave$/);
  if (method === 'POST' && serverLeaveMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverLeaveMatch[1]);
    if (officialAnnouncements.isServer(serverId)) return sendJson(response, 403, { error: 'Everyone stays in the official Glean announcements server.' });
    const owner = findServerOwner.get(serverId);
    if (!owner || !isServerMember.get(serverId, user.id)) return sendJson(response, 404, { error: 'Server not found.' });
    if (owner.owner_id === user.id) return sendJson(response, 400, { error: 'The owner cannot leave. Delete or transfer the server first.' });
    writeServerAudit(serverId, user, 'member.left', { targetType: 'member', targetId: user.id, targetName: user.username });
    removeServerMember.run(serverId, user.id);
    leaveVoiceRooms(user.id);
    sendEvent(user.id, 'server-membership', { serverId, action: 'left' });
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'member-left' });
    return sendJson(response, 200, { ok: true });
  }

  if (method === 'DELETE' && serverMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverMatch[1]);
    if (officialAnnouncements.isServer(serverId)) return sendJson(response, 403, { error: 'The official Glean announcements server cannot be deleted here.' });
    const owner = findServerOwner.get(serverId);
    if (!canOwnServer(user, serverId)) return sendJson(response, 403, { error: 'Only the server owner can delete this server.' });
    const doomed = findServerById.get(serverId);
    notifyServerMembers(serverId, 'server-membership', { serverId, action: 'deleted' });
    closeVoiceRoomsForServer(serverId);
    const storedUploads = listChannelAttachmentStorageForServer.all(serverId).map((row) => row.storage_name);
    const iconName = serverIconFileName(doomed?.icon_url);
    const bannerName = bannerFileName(publicServerBanner(doomed?.banner_json));
    removeServer.run(serverId);
    removeStoredUploads([iconName, bannerName, ...storedUploads].filter(Boolean));
    return sendJson(response, 200, { ok: true });
  }

  if (method === 'PATCH' && serverMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverMatch[1]);
    if (!canOwnServer(user, serverId)) return sendJson(response, 403, { error: 'Only the server owner can edit this server.' });
    const current = findServerById.get(serverId);
    if (!current) return sendJson(response, 404, { error: 'Server not found.' });
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    if (input.isPublic !== undefined && Number(current.owner_id) !== Number(user.id)) return sendJson(response, 403, { error: 'Only the server owner can change server visibility.' });
    const nextName = input.name !== undefined ? String(input.name || '').trim().replace(/\s+/g, ' ') : current.name;
    const nextDescription = input.description !== undefined ? String(input.description || '').trim().slice(0, 200) : (current.description || '');
    if (nextName.length < 2 || nextName.length > 60) return sendJson(response, 400, { error: 'Server name must be 2–60 characters.' });
    if (officialAnnouncements.isServer(serverId) && nextName !== 'Glean') return sendJson(response, 400, { error: 'The official server keeps the Glean name.' });
    if (input.moderationEnabled !== undefined && typeof input.moderationEnabled !== 'boolean') return sendJson(response, 400, { error: 'Moderation enabled must be true or false.' });
    if (input.isPublic !== undefined && typeof input.isPublic !== 'boolean') return sendJson(response, 400, { error: 'Public visibility must be true or false.' });
    const nextModerationEnabled = input.moderationEnabled === undefined ? Number(current.moderation_enabled) : Number(input.moderationEnabled);
    const nextIsPublic = input.isPublic === undefined ? Number(current.is_public) : Number(input.isPublic);
    const moderationChanged = nextModerationEnabled !== Number(current.moderation_enabled);
    const visibilityChanged = nextIsPublic !== Number(current.is_public);
    updateServerProfile.run(nextName, nextDescription, nextModerationEnabled, nextIsPublic, serverId);
    writeServerAudit(serverId, user, 'server.updated', { targetType: 'server', targetId: serverId, targetName: nextName, details: { nameChanged: nextName !== current.name, descriptionChanged: nextDescription !== (current.description || ''), moderationChanged, moderationEnabled: Boolean(nextModerationEnabled), visibilityChanged, isPublic: Boolean(nextIsPublic) } });
    notifyServerMembers(serverId, 'server-updated', { serverId, action: visibilityChanged ? 'visibility' : moderationChanged ? 'moderation' : 'profile' });
    return sendJson(response, 200, { server: publicServerSummary(findServerById.get(serverId)) });
  }

  if (method === 'GET' && serverMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverMatch[1]);
    if (!canSeeServer(user, serverId)) return sendJson(response, 404, { error: 'Server not found.' });
    const member = findServerMember.get(serverId, user.id);
    const deviceHash = serverDeviceHash(request, serverId);
    if (member && deviceHash) {
      if (isServerDeviceBanned.get(serverId, deviceHash)) return sendJson(response, 403, { error: 'This Glean installation is banned from this server.' });
      recordServerMemberDevice.run(serverId, user.id, deviceHash, now, now);
    }
    const inspecting = !member && isPlatformAdmin(user);
    const unread = member ? channelUnreadMapForServer(user.id, serverId) : new Map();
    const memberLimit = 50;
    const initialMembers = listServerMembersPage.all(serverId, memberLimit, 0).map(publicServerMember);
    const memberTotal = Number(countServerMembers.get(serverId)?.count || 0);
    const memberCounts = Object.fromEntries(countServerMembersByRole.all(serverId).map((row) => [String(row.roleId), Number(row.count)]));
    return sendJson(response, 200, { server: { ...publicServerSummary(findServerById.get(serverId)), categories: serverCategories.list(serverId), channels: listServerChannels.all(serverId).map((row) => publicChannel(row, unread.get(Number(row.id)))), bots: listInstalledServerBots.all(serverId).map((bot) => ({ id: bot.id, name: bot.name, avatarUrl: bot.avatar_url || null, installedAt: bot.installed_at })), roles: listServerRoles.all(serverId).map((row) => ({ ...row, permissionFlags: roleFlags(row) })), members: initialMembers, memberTotal, memberCounts, membersPage: { offset: 0, limit: memberLimit, hasMore: initialMembers.length < memberTotal, nextOffset: initialMembers.length }, membership: member ? { roleId: Number(member.role_id), roleName: member.role_name, permissions: member.permissions, permissionFlags: roleFlags(member), timeoutUntil: timeoutUntilFor(serverId, user.id) } : { roleId: null, roleName: 'Platform', permissions: 'observer', permissionFlags: [], inspecting: true, timeoutUntil: null }, inspecting, voiceOccupancy: occupancyForServer(serverId).channels, liveApps: appService.liveSessionsForServer(serverId) } });
  }

  const serverMembersMatch = path.match(/^\/api\/servers\/(\d+)\/members$/);
  if (method === 'GET' && serverMembersMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverMembersMatch[1]);
    if (!canSeeServer(user, serverId)) return sendJson(response, 404, { error: 'Server not found.' });
    const query = new URL(request.url, `http://${request.headers.host || 'localhost'}`).searchParams;
    const offset = Math.max(0, Number.parseInt(query.get('offset') || '0', 10) || 0);
    const limit = Math.min(50, Math.max(1, Number.parseInt(query.get('limit') || '50', 10) || 50));
    const rows = listServerMembersPage.all(serverId, limit + 1, offset);
    const hasMore = rows.length > limit;
    const members = rows.slice(0, limit).map(publicServerMember);
    const total = Number(countServerMembers.get(serverId)?.count || 0);
    const memberCounts = Object.fromEntries(countServerMembersByRole.all(serverId).map((row) => [String(row.roleId), Number(row.count)]));
    return sendJson(response, 200, { members, memberTotal: total, memberCounts, page: { offset, limit, hasMore, nextOffset: offset + members.length } });
  }

  const serverIconMatch = path.match(/^\/api\/servers\/(\d+)\/icon$/);
  if (serverIconMatch && (method === 'POST' || method === 'DELETE')) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverIconMatch[1]);
    if (!canOwnServer(user, serverId)) return sendJson(response, 403, { error: 'Only the server owner can change the server photo.' });
    const current = findServerById.get(serverId);
    if (!current) return sendJson(response, 404, { error: 'Server not found.' });
    const previousName = serverIconFileName(current.icon_url);
    let nextUrl = null;
    if (method === 'POST') {
      const formRequest = new Request(`http://${request.headers.host || 'localhost'}${request.url}`, { method: request.method, headers: request.headers, body: Readable.toWeb(request), duplex: 'half' });
      const file = (await formRequest.formData()).get('icon');
      if (!file || String(file.type || '').toLowerCase() !== 'image/jpeg' || file.size > 8 * 1024 * 1024) {
        return sendJson(response, 400, { error: 'Choose a JPG up to 8 MB.' });
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
        return sendJson(response, 400, { error: 'Choose a JPG up to 8 MB.' });
      }
      const storageName = `server-icon-${randomBase32(18)}.jpg`;
      writeFileSync(join(uploadDirectory, storageName), bytes, { mode: 0o600 });
      nextUrl = `${apiPrefix}/server-icons/${storageName}`;
    }
    updateServerIcon.run(nextUrl, serverId);
    if (previousName && previousName !== serverIconFileName(nextUrl)) removeStoredUploads([previousName]);
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'icon' });
    writeServerAudit(serverId, user, method === 'DELETE' ? 'server.icon-removed' : 'server.icon-updated', { targetType: 'server', targetId: serverId, targetName: current.name });
    return sendJson(response, 200, { server: publicServerSummary(findServerById.get(serverId)) });
  }

  const serverBannerMatch = path.match(/^\/api\/servers\/(\d+)\/banner$/);
  if (method === 'POST' && serverBannerMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverBannerMatch[1]);
    if (!canOwnServer(user, serverId)) return sendJson(response, 403, { error: 'Only the server owner can change the invite splash.' });
    const current = findServerById.get(serverId);
    if (!current) return sendJson(response, 404, { error: 'Server not found.' });
    const previous = publicServerBanner(current.banner_json);
    const contentType = String(request.headers['content-type'] || '');
    let next = null;
    if (contentType.startsWith('multipart/form-data')) {
      const formRequest = new Request(`http://${request.headers.host || 'localhost'}${request.url}`, { method: request.method, headers: request.headers, body: Readable.toWeb(request), duplex: 'half' });
      const file = (await formRequest.formData()).get('banner');
      if (!file || String(file.type || '').toLowerCase() !== 'image/jpeg' || file.size > 8 * 1024 * 1024) {
        return sendJson(response, 400, { error: 'Choose a JPG up to 8 MB.' });
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
        return sendJson(response, 400, { error: 'Choose a JPG up to 8 MB.' });
      }
      const storageName = `server-banner-${randomBase32(18)}.jpg`;
      writeFileSync(join(uploadDirectory, storageName), bytes, { mode: 0o600 });
      next = { kind: 'image', imageUrl: `${apiPrefix}/server-banners/${storageName}` };
    } else {
      let input;
      try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
      if (input.kind === 'none') {
        next = null;
      } else if (input.kind === 'solid') {
        next = publicServerBanner({ kind: 'solid', color: input.color });
        if (!next) return sendJson(response, 400, { error: 'Pick a valid color.' });
      } else if (input.kind === 'gradient') {
        next = publicServerBanner({ kind: 'gradient', from: input.from, to: input.to, angle: input.angle });
        if (!next) return sendJson(response, 400, { error: 'Pick two colors and a direction.' });
      } else if (input.kind === 'image') {
        const keep = publicServerBanner({ kind: 'image', imageUrl: input.imageUrl });
        if (!keep || keep.imageUrl !== previous?.imageUrl) return sendJson(response, 400, { error: 'Upload a photo to use as the invite splash.' });
        next = keep;
      } else {
        return sendJson(response, 400, { error: 'Pick a color, gradient, or photo.' });
      }
    }
    const oldName = bannerFileName(previous);
    const newName = bannerFileName(next);
    updateServerBanner.run(next ? JSON.stringify(next) : null, serverId);
    if (oldName && oldName !== newName) removeStoredUploads([oldName]);
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'banner' });
    writeServerAudit(serverId, user, 'server.banner-updated', { targetType: 'server', targetId: serverId, targetName: current.name });
    return sendJson(response, 200, { server: publicServerSummary(findServerById.get(serverId)) });
  }

  const serverBannerFileMatch = path.match(/^\/api\/server-banners\/(server-banner-[a-z2-7]+\.jpg)$/i);
  if (method === 'GET' && serverBannerFileMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const name = serverBannerFileMatch[1].toLowerCase();
    if (!SERVER_BANNER_FILE.test(name)) return sendJson(response, 404, { error: 'Server banner not found.' });
    const owner = findServerByBannerUrl.get(`${apiPrefix}/server-banners/${name}`, `/api/server-banners/${name}`);
    if (!owner || !canSeeServer(user, owner.id)) return sendJson(response, 404, { error: 'Server banner not found.' });
    const filePath = join(uploadDirectory, name);
    if (!existsSync(filePath)) return sendJson(response, 404, { error: 'Server banner not found.' });
    return sendLocalFile(request, response, filePath, {
      type: 'image/jpeg',
      extra: { 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  const serverIconFileMatch = path.match(/^\/api\/server-icons\/(server-icon-[a-z2-7]+\.jpg)$/i);
  if (method === 'GET' && serverIconFileMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const name = serverIconFileMatch[1].toLowerCase();
    if (!SERVER_ICON_FILE.test(name)) return sendJson(response, 404, { error: 'Server photo not found.' });
    const owner = database.prepare('SELECT id, icon_url FROM servers WHERE icon_url = ? OR icon_url = ?').get(`${apiPrefix}/server-icons/${name}`, `/api/server-icons/${name}`);
    if (!owner || !canSeeServer(user, owner.id)) return sendJson(response, 404, { error: 'Server photo not found.' });
    const filePath = join(uploadDirectory, name);
    if (!existsSync(filePath)) return sendJson(response, 404, { error: 'Server photo not found.' });
    return sendLocalFile(request, response, filePath, {
      type: 'image/jpeg',
      extra: { 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  const serverInviteDeleteMatch = path.match(/^\/api\/servers\/(\d+)\/invites\/([a-z2-7]+)$/i);
  if (method === 'DELETE' && serverInviteDeleteMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverInviteDeleteMatch[1]);
    if (!canServerPermission(user, serverId, 'manageInvites')) return sendJson(response, 403, { error: 'Manage invites permission required.' });
    const result = deleteServerInvite.run(serverInviteDeleteMatch[2].toLowerCase(), serverId);
    if (!result.changes) return sendJson(response, 404, { error: 'Invite not found.' });
    writeServerAudit(serverId, user, 'invite.revoked', { targetType: 'server', targetId: serverId, targetName: findServerById.get(serverId)?.name || '' });
    return sendJson(response, 200, { ok: true });
  }

  const serverBansMatch = path.match(/^\/api\/servers\/(\d+)\/bans$/);
  if (method === 'GET' && serverBansMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverBansMatch[1]);
    if (!canServerPermission(user, serverId, 'manageMembers')) return sendJson(response, 403, { error: 'Manage members permission required.' });
    return sendJson(response, 200, {
      bans: listServerBans.all(serverId).map((ban) => ({
        userId: Number(ban.user_id),
        username: ban.username,
        avatarUrl: ban.avatar_url || null,
        reason: ban.reason || '',
        createdAt: ban.created_at,
        bannedBy: ban.banned_by || null,
      })),
    });
  }

  const serverDeviceBansMatch = path.match(/^\/api\/servers\/(\d+)\/device-bans$/);
  if (method === 'GET' && serverDeviceBansMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverDeviceBansMatch[1]);
    if (!canServerPermission(user, serverId, 'manageMembers')) return sendJson(response, 403, { error: 'Manage members permission required.' });
    return sendJson(response, 200, { deviceBans: listServerDeviceBans.all(serverId).map((ban) => ({
      deviceHash: ban.device_hash,
      label: `Installation ${ban.device_hash.slice(0, 10)}`,
      reason: ban.reason || '',
      createdAt: ban.created_at,
      bannedBy: ban.banned_by || null,
    })) });
  }

  const serverDeviceUnbanMatch = path.match(/^\/api\/servers\/(\d+)\/device-bans\/([a-f0-9]{64})$/i);
  if (method === 'DELETE' && serverDeviceUnbanMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverDeviceUnbanMatch[1]);
    const deviceHash = serverDeviceUnbanMatch[2].toLowerCase();
    if (!canServerPermission(user, serverId, 'manageMembers')) return sendJson(response, 403, { error: 'Manage members permission required.' });
    if (!deleteServerDeviceBan.run(serverId, deviceHash).changes) return sendJson(response, 404, { error: 'That installation is not banned.' });
    writeServerAudit(serverId, user, 'member.device-unbanned', { targetType: 'device', targetId: deviceHash.slice(0, 10), targetName: `Installation ${deviceHash.slice(0, 10)}` });
    return sendJson(response, 200, { ok: true });
  }

  const serverUnbanMatch = path.match(/^\/api\/servers\/(\d+)\/bans\/(\d+)$/);
  if (method === 'DELETE' && serverUnbanMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverUnbanMatch[1]);
    const targetUserId = Number(serverUnbanMatch[2]);
    if (!canServerPermission(user, serverId, 'manageMembers')) return sendJson(response, 403, { error: 'Manage members permission required.' });
    const result = deleteServerBan.run(serverId, targetUserId);
    if (!result.changes) return sendJson(response, 404, { error: 'That user is not banned.' });
    writeServerAudit(serverId, user, 'member.unbanned', { targetType: 'member', targetId: targetUserId, targetName: `User ${targetUserId}` });
    if (officialAnnouncements.isServer(serverId) && officialAnnouncements.enroll(targetUserId)) {
      initChannelReadsForMember(serverId, targetUserId);
      sendEvent(targetUserId, 'server-membership', { serverId, action: 'joined' });
      notifyServerMembers(serverId, 'server-updated', { serverId, action: 'member-unbanned' });
    }
    return sendJson(response, 200, { ok: true });
  }

  const serverRolesMatch = path.match(/^\/api\/servers\/(\d+)\/roles$/);
  if (method === 'POST' && serverRolesMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverRolesMatch[1]);
    const owner = findServerOwner.get(serverId);
    if (!canServerPermission(user, serverId, 'manageRoles')) return sendJson(response, 403, { error: 'Manage roles permission required.' });
    const { name, color = '#99aab5', permissions = 'member', permissionFlags = MODERATOR_FLAGS } = await readJson(request);
    const cleanName = String(name || '').trim().slice(0, 32);
    const cleanColor = String(color).trim().toLowerCase();
    if (!cleanName || !/^#[0-9a-f]{6}$/.test(cleanColor) || !['member', 'moderator'].includes(permissions)) return sendJson(response, 400, { error: 'Provide a role name, hex color, and valid permissions.' });
    if (!validRoleFlags(permissionFlags)) return sendJson(response, 400, { error: 'Invalid moderator permissions.' });
    if (findServerRoleByName.get(serverId, cleanName)) return sendJson(response, 409, { error: 'A role with that name already exists.' });
    const highestCustomPosition = Math.max(
      0,
      ...listServerRoles.all(serverId)
        .filter((role) => role.permissions !== 'owner' && role.name !== 'Member')
        .map((role) => Number(role.position) || 0),
    );
    const position = highestCustomPosition + 1;
    if (position >= 100) return sendJson(response, 400, { error: 'A server can have up to 99 custom roles.' });
    const result = insertRole.run(serverId, cleanName, cleanColor, permissions, position);
    database.prepare('UPDATE server_roles SET permission_flags = ? WHERE id = ?').run(permissions === 'moderator' ? JSON.stringify(permissionFlags) : null, Number(result.lastInsertRowid));
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'role-created' });
    writeServerAudit(serverId, user, 'role.created', { targetType: 'role', targetId: result.lastInsertRowid, targetName: cleanName, details: { permissions } });
    return sendJson(response, 201, { role: { id: Number(result.lastInsertRowid), name: cleanName, color: cleanColor, permissions, permissionFlags: permissions === 'moderator' ? permissionFlags : [], position } });
  }

  const serverRoleOrderMatch = path.match(/^\/api\/servers\/(\d+)\/roles\/order$/);
  if (method === 'PATCH' && serverRoleOrderMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverRoleOrderMatch[1]);
    if (!canServerPermission(user, serverId, 'manageRoles')) return sendJson(response, 403, { error: 'Manage roles permission required.' });
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    const roleIds = parseIdList(input.roleIds);
    if (!roleIds) return sendJson(response, 400, { error: 'Provide a unique list of role ids.' });
    const roles = listServerRoles.all(serverId);
    const reorderableIds = roles
      .filter((role) => role.permissions !== 'owner' && role.name !== 'Member')
      .map((role) => Number(role.id));
    if (!sameIdSet(reorderableIds, roleIds)) return sendJson(response, 400, { error: 'Role order must include every custom role exactly once.' });
    withTransaction(() => {
      roleIds.forEach((roleId, index) => updateServerRolePosition.run(roleIds.length - index, roleId, serverId));
    });
    const updatedRoles = listServerRoles.all(serverId);
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'role-reordered' });
    writeServerAudit(serverId, user, 'role.reordered', { targetType: 'server', targetId: serverId, targetName: findServerById.get(serverId)?.name || '', details: { roleIds } });
    return sendJson(response, 200, { roles: updatedRoles });
  }

  const serverRoleMatch = path.match(/^\/api\/servers\/(\d+)\/roles\/(\d+)$/);
  if (serverRoleMatch && (method === 'PATCH' || method === 'DELETE')) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverRoleMatch[1]);
    const roleId = Number(serverRoleMatch[2]);
    const owner = findServerOwner.get(serverId);
    if (!canServerPermission(user, serverId, 'manageRoles')) return sendJson(response, 403, { error: 'Manage roles permission required.' });
    const role = findServerRole.get(roleId, serverId);
    if (!role) return sendJson(response, 404, { error: 'Role not found.' });
    if (role.name === 'Member') return sendJson(response, 400, { error: 'The Member role cannot be changed.' });
    if (method === 'DELETE') {
      if (role.permissions === 'owner') return sendJson(response, 400, { error: 'The Owner role cannot be deleted.' });
      reassignRoleMembers.run(serverId, serverId, roleId);
      deleteServerRole.run(roleId, serverId);
      notifyServerMembers(serverId, 'server-updated', { serverId, action: 'role-deleted', roleId });
      writeServerAudit(serverId, user, 'role.deleted', { targetType: 'role', targetId: roleId, targetName: role.name });
      return sendJson(response, 200, { ok: true });
    }
    const input = await readJson(request);
    const cleanName = String(input.name || '').trim().slice(0, 32);
    if (role.permissions === 'owner') {
      if (!cleanName) return sendJson(response, 400, { error: 'Provide an owner role name.' });
      if (input.color !== undefined || input.permissions !== undefined || input.permissionFlags !== undefined) return sendJson(response, 400, { error: 'Only the Owner role name can be changed.' });
      const duplicate = findServerRoleByName.get(serverId, cleanName);
      if (duplicate && Number(duplicate.id) !== roleId) return sendJson(response, 409, { error: 'A role with that name already exists.' });
      updateServerRole.run(cleanName, role.color, role.permissions, role.permission_flags, roleId, serverId);
      notifyServerMembers(serverId, 'server-updated', { serverId, action: 'owner-role-renamed', roleId });
      writeServerAudit(serverId, user, 'role.renamed', { targetType: 'role', targetId: roleId, targetName: cleanName, details: { previousName: role.name } });
      return sendJson(response, 200, { role: { ...role, id: roleId, name: cleanName } });
    }
    const cleanColor = String(input.color || '').trim().toLowerCase();
    const permissions = input.permissions || role.permissions;
    const permissionFlags = input.permissionFlags === undefined ? roleFlags(role) : input.permissionFlags;
    if (!cleanName || !/^#[0-9a-f]{6}$/.test(cleanColor) || !['member', 'moderator'].includes(permissions)) return sendJson(response, 400, { error: 'Provide a role name, hex color, and valid permissions.' });
    if (!validRoleFlags(permissionFlags)) return sendJson(response, 400, { error: 'Invalid moderator permissions.' });
    const duplicate = findServerRoleByName.get(serverId, cleanName);
    if (duplicate && Number(duplicate.id) !== roleId) return sendJson(response, 409, { error: 'A role with that name already exists.' });
    updateServerRole.run(cleanName, cleanColor, permissions, permissions === 'moderator' ? JSON.stringify(permissionFlags) : null, roleId, serverId);
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'role-updated', roleId });
    writeServerAudit(serverId, user, 'role.updated', { targetType: 'role', targetId: roleId, targetName: cleanName, details: { permissions, permissionFlags: permissions === 'moderator' ? permissionFlags : [] } });
    return sendJson(response, 200, { role: { ...role, id: roleId, name: cleanName, color: cleanColor, permissions, permissionFlags: permissions === 'moderator' ? permissionFlags : [] } });
  }

  const serverChannelsMatch = path.match(/^\/api\/servers\/(\d+)\/channels$/);
  if (method === 'POST' && serverChannelsMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverChannelsMatch[1]);
    const owner = findServerOwner.get(serverId);
    const actor = findServerMember.get(serverId, user.id);
    if (!canServerPermission(user, serverId, 'manageChannels')) return sendJson(response, 403, { error: 'Manage channels permission required.' });
    const { name, type = 'text', categoryId = null } = await readJson(request);
    const cleanName = sanitizeChannelName(name);
    if (!cleanName) return sendJson(response, 400, { error: 'Channel name is required.' });
    if (!CHANNEL_CREATE_TYPES.has(type)) return sendJson(response, 400, { error: 'Channel type must be text, announcement, rules, or voice.' });
    if (!serverCategories.belongs(serverId, categoryId)) return sendJson(response, 400, { error: 'Category must belong to this server.' });
    const voice = type === 'voice' ? 1 : 0;
    const channelKind = channelKindFrom(type, cleanName, voice);
    const locked = channelKind === 'announcement' || channelKind === 'rules' ? 1 : 0;
    const position = listServerChannels.all(serverId).length;
    let result;
    withTransaction(() => {
      result = insertCustomChannel.run(serverId, cleanName, voice, channelKind, locked, position);
      updateChannelCategory.run(categoryId, Number(result.lastInsertRowid), serverId);
    });
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'channel-created' });
    writeServerAudit(serverId, user, 'channel.created', { targetType: 'channel', targetId: result.lastInsertRowid, targetName: cleanName, details: { kind: channelKind, voice: Boolean(voice) } });
    return sendJson(response, 201, { channel: publicChannel(findChannel.get(Number(result.lastInsertRowid))) });
  }

  const serverChannelOrderMatch = path.match(/^\/api\/servers\/(\d+)\/channels\/order$/);
  if (method === 'PATCH' && serverChannelOrderMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(serverChannelOrderMatch[1]);
    if (!canServerPermission(user, serverId, 'manageChannels')) return sendJson(response, 403, { error: 'Manage channels permission required.' });
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    const channelIds = parseIdList(input.channelIds);
    if (!channelIds?.length) return sendJson(response, 400, { error: 'Provide a unique list of channel ids.' });
    const rows = listServerChannels.all(serverId);
    const selected = channelIds.map((id) => rows.find((row) => Number(row.id) === id));
    if (selected.some((row) => !row)) return sendJson(response, 400, { error: 'Every channel must belong to this server.' });
    const voice = Boolean(selected[0]?.voice);
    if (input.scope !== undefined && input.scope !== 'all') return sendJson(response, 400, { error: 'Invalid channel order scope.' });
    if (input.scope !== 'all' && selected.some((row) => Boolean(row.voice) !== voice)) return sendJson(response, 400, { error: 'Reorder text and voice channels separately.' });
    const kindIds = rows.filter((row) => input.scope === 'all' || Boolean(row.voice) === voice).map((row) => Number(row.id));
    if (!sameIdSet(kindIds, channelIds)) return sendJson(response, 400, { error: 'Channel order must include every channel of that type.' });
    withTransaction(() => {
      channelIds.forEach((channelId, index) => updateChannelPosition.run(index, channelId, serverId));
    });
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'channel-reordered' });
    writeServerAudit(serverId, user, 'channel.reordered', { targetType: 'server', targetId: serverId, targetName: findServerById.get(serverId)?.name || '', details: { channelIds } });
    return sendJson(response, 200, { ok: true, channelIds });
  }

  const channelCleanupMatch = path.match(/^\/api\/servers\/(\d+)\/channels\/(\d+)\/(clear-messages|message-cleanup)$/);
  if (method === 'POST' && channelCleanupMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(channelCleanupMatch[1]);
    const channelId = Number(channelCleanupMatch[2]);
    const action = channelCleanupMatch[3];
    if (!canServerPermission(user, serverId, 'manageMessages')) return sendJson(response, 403, { error: 'Manage messages permission required.' });
    const channelRecord = findChannel.get(channelId);
    if (!channelRecord || Number(channelRecord.server_id) !== serverId) return sendJson(response, 404, { error: 'Channel not found.' });
    if (channelRecord.voice) return sendJson(response, 400, { error: 'Message cleanup only applies to text channels.' });
    if (action === 'clear-messages') {
      const counts = permanentlyClearChannelMessages(channelId);
      writeServerAudit(serverId, user, 'channel.messages-cleared', { targetType: 'channel', targetId: channelId, targetName: channelRecord.name, details: { deletedCount: counts.deletedCount } });
      notifyServerMembers(serverId, 'channel-messages-cleared', { serverId, channelId, deletedCount: counts.deletedCount, scheduled: false });
      notifyServerMembers(serverId, 'server-updated', { serverId, action: 'channel-messages-cleared', channelId });
      return sendJson(response, 200, { ok: true, ...counts });
    }
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    const intervalSeconds = Number(input.intervalSeconds);
    const allowedIntervals = new Set([0, 1800, 3600, 21600, 43200, 86400, 604800]);
    if (!Number.isInteger(intervalSeconds) || !allowedIntervals.has(intervalSeconds)) return sendJson(response, 400, { error: 'Choose a supported cleanup interval.' });
    const now = new Date();
    if (intervalSeconds === 0) deleteChannelCleanupSchedule.run(channelId);
    else updateChannelCleanupSchedule.run(channelId, intervalSeconds, new Date(now.getTime() + intervalSeconds * 1000).toISOString(), user.id, now.toISOString());
    const updatedChannel = listServerChannels.all(serverId).find((row) => Number(row.id) === channelId);
    writeServerAudit(serverId, user, intervalSeconds === 0 ? 'channel.message-cleanup-disabled' : 'channel.message-cleanup-scheduled', { targetType: 'channel', targetId: channelId, targetName: channelRecord.name, details: { intervalSeconds } });
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'channel-cleanup-schedule-updated', channelId });
    return sendJson(response, 200, { channel: publicChannel(updatedChannel) });
  }

  const channelDeleteMatch = path.match(/^\/api\/servers\/(\d+)\/channels\/(\d+)$/);
  if (method === 'PATCH' && channelDeleteMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(channelDeleteMatch[1]);
    const channelId = Number(channelDeleteMatch[2]);
    if (!canServerPermission(user, serverId, 'manageChannels')) return sendJson(response, 403, { error: 'Manage channels permission required.' });
    const channelRecord = findChannel.get(channelId);
    if (!channelRecord || Number(channelRecord.server_id) !== serverId) return sendJson(response, 404, { error: 'Channel not found.' });
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    const nextName = input.name !== undefined ? sanitizeChannelName(input.name) : channelRecord.name;
    const nextCategory = input.categoryId === undefined ? channelRecord.category_id ?? null : input.categoryId;
    if (!serverCategories.belongs(serverId, nextCategory)) return sendJson(response, 400, { error: 'Category must belong to this server.' });
    if (!nextName) return sendJson(response, 400, { error: 'Channel name is required.' });
    if (input.type !== undefined && !CHANNEL_CREATE_TYPES.has(input.type)) return sendJson(response, 400, { error: 'Invalid channel type.' });
    const nextVoice = input.type === undefined ? Number(channelRecord.voice) : Number(input.type === 'voice');
    if (nextVoice !== Number(channelRecord.voice) && voiceRooms.get(`${serverId}:${channelId}`)?.size) return sendJson(response, 409, { error: 'Wait until the voice channel is empty before changing its type.' });
    if (officialAnnouncements.isRequiredChannel(channelId) && nextVoice) return sendJson(response, 400, { error: 'The official announcements channel must remain a text channel.' });
    let nextKind = channelRecord.channel_kind === 'announcement' || channelRecord.channel_kind === 'rules' ? channelRecord.channel_kind : 'text';
    if (nextVoice) nextKind = 'text';
    else if (input.type !== undefined) nextKind = input.type;
    else if (input.channelKind !== undefined) {
      const wanted = String(input.channelKind || '').toLowerCase();
      if (!CHANNEL_KINDS.has(wanted)) return sendJson(response, 400, { error: 'Channel kind must be text, announcement, or rules.' });
      nextKind = wanted;
    } else if (input.name !== undefined) {
      const implied = channelKindFrom('', nextName, 0);
      if (implied !== 'text') nextKind = implied;
    }
    let nextLocked = Number(channelRecord.locked) ? 1 : 0;
    if (nextKind === 'announcement' || nextKind === 'rules') nextLocked = 1;
    else if (input.locked !== undefined) nextLocked = input.locked ? 1 : 0;
    let nextSlowmode = Number(channelRecord.slowmode || 0);
    if (officialAnnouncements.isRequiredChannel(channelId) && (nextKind !== 'announcement' || nextName !== 'announcements')) {
      return sendJson(response, 400, { error: 'The official announcements channel must keep its name and type.' });
    }
    if (input.slowmode !== undefined) {
      const value = Number(input.slowmode);
      if (!SLOWMODE_SECONDS.has(value)) return sendJson(response, 400, { error: 'Slowmode must be a supported interval.' });
      nextSlowmode = nextVoice ? 0 : value;
    }
    const nextTopic = input.topic !== undefined ? String(input.topic || '').trim().slice(0, 200) : String(channelRecord.topic || '');
    if (nextVoice) { nextSlowmode = 0; nextLocked = 0; }
    withTransaction(() => {
      updateChannelSettings.run(nextName, nextTopic, nextLocked, nextSlowmode, nextKind, nextVoice, channelId, serverId);
      updateChannelCategory.run(nextCategory, channelId, serverId);
    });
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'channel-updated', channelId });
    writeServerAudit(serverId, user, 'channel.updated', { targetType: 'channel', targetId: channelId, targetName: nextName, details: { nameChanged: nextName !== channelRecord.name, slowmode: nextSlowmode, locked: Boolean(nextLocked), kind: nextKind } });
    return sendJson(response, 200, { channel: publicChannel(findChannel.get(channelId)) });
  }

  if (method === 'DELETE' && channelDeleteMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(channelDeleteMatch[1]);
    const channelId = Number(channelDeleteMatch[2]);
    if (officialAnnouncements.isRequiredChannel(channelId)) return sendJson(response, 403, { error: 'The official announcements channel cannot be deleted.' });
    const owner = findServerOwner.get(serverId);
    const actor = findServerMember.get(serverId, user.id);
    const channelRecord = findChannel.get(channelId);
    if (!channelRecord || Number(channelRecord.server_id) !== serverId) return sendJson(response, 404, { error: 'Channel not found.' });
    if (!canServerPermission(user, serverId, 'manageChannels')) return sendJson(response, 403, { error: 'Manage channels permission required.' });
    if (channelRecord.name === 'general') return sendJson(response, 400, { error: 'The general channel cannot be deleted.' });
    if (Number(countServerChannels.get(serverId).count) <= 1) return sendJson(response, 400, { error: 'A server must keep one channel.' });
    const storedUploads = listChannelAttachmentStorageForChannel.all(channelId).map((row) => row.storage_name);
    emptyVoiceRoom(`${serverId}:${channelId}`);
    removeChannel.run(channelId, serverId);
    removeStoredUploads(storedUploads);
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'channel-deleted', channelId });
    writeServerAudit(serverId, user, 'channel.deleted', { targetType: 'channel', targetId: channelId, targetName: channelRecord.name });
    return sendJson(response, 200, { ok: true });
  }

  const memberRoleMatch = path.match(/^\/api\/servers\/(\d+)\/members\/(\d+)\/role$/);
  if (method === 'POST' && memberRoleMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(memberRoleMatch[1]);
    const targetUserId = Number(memberRoleMatch[2]);
    const owner = findServerOwner.get(serverId);
    const actor = findServerMember.get(serverId, user.id);
    const target = findServerMember.get(serverId, targetUserId);
    if (!canServerPermission(user, serverId, 'manageMembers')) return sendJson(response, 403, { error: 'Manage members permission required.' });
    if (!target || target.permissions === 'owner' || (actor?.permissions === 'moderator' && target.permissions === 'moderator')) return sendJson(response, 403, { error: 'You cannot change this member.' });
    const { roleId } = await readJson(request);
    const role = findRole.get(Number(roleId));
    if (!role || role.server_id !== serverId || role.permissions === 'owner') return sendJson(response, 404, { error: 'Member or role not found.' });
    if (actor?.permissions === 'moderator' && role.permissions === 'moderator') return sendJson(response, 403, { error: 'Only the owner can assign moderator roles.' });
    updateMemberRole.run(role.id, serverId, targetUserId);
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'member-role-updated' });
    const targetName = listServerMembers.all(serverId).find((item) => Number(item.user_id) === targetUserId)?.username || `User ${targetUserId}`;
    writeServerAudit(serverId, user, 'member.role-changed', { targetType: 'member', targetId: targetUserId, targetName, details: { roleName: role.name } });
    return sendJson(response, 200, { ok: true });
  }

  const voiceDisconnectMatch = path.match(/^\/api\/servers\/(\d+)\/voice-members\/(\d+)\/disconnect$/);
  if (method === 'POST' && voiceDisconnectMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(voiceDisconnectMatch[1]);
    const targetUserId = Number(voiceDisconnectMatch[2]);
    const actor = findServerMember.get(serverId, user.id);
    const target = findServerMember.get(serverId, targetUserId);
    if (!canServerPermission(user, serverId, 'manageVoice')) return sendJson(response, 403, { error: 'Manage voice permission required.' });
    if (targetUserId === Number(user.id)) return sendJson(response, 400, { error: 'You cannot disconnect yourself.' });
    if (!target || target.permissions === 'owner' || (actor?.permissions === 'moderator' && target.permissions === 'moderator')) return sendJson(response, 403, { error: 'You cannot disconnect this member.' });
    const targetName = listServerMembers.all(serverId).find((item) => Number(item.user_id) === targetUserId)?.username || `User ${targetUserId}`;
    const disconnectedChannels = leaveVoiceRooms(targetUserId, null, serverId);
    if (!disconnectedChannels.length) return sendJson(response, 409, { error: 'That member is not connected to voice in this server.' });
    for (const channelId of disconnectedChannels) sendEvent(targetUserId, 'voice-disconnected', { serverId, channelId });
    writeServerAudit(serverId, user, 'voice.member-disconnected', { targetType: 'member', targetId: targetUserId, targetName });
    return sendJson(response, 200, { ok: true });
  }

  const memberModerationMatch = path.match(/^\/api\/servers\/(\d+)\/members\/(\d+)\/(kick|ban)$/);
  if (method === 'POST' && memberModerationMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(memberModerationMatch[1]);
    const targetUserId = Number(memberModerationMatch[2]);
    const action = memberModerationMatch[3];
    const isOfficialServer = officialAnnouncements.isServer(serverId);
    const actor = findServerMember.get(serverId, user.id);
    const target = findServerMember.get(serverId, targetUserId);
    if (!canServerPermission(user, serverId, 'manageMembers')) return sendJson(response, 403, { error: 'Manage members permission required.' });
    if (!target || target.permissions === 'owner' || (actor?.permissions === 'moderator' && target.permissions === 'moderator')) return sendJson(response, 403, { error: 'You cannot moderate this member.' });
    let reason = '';
    if (action === 'ban') {
      let input = {};
      try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
      reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
    }
    const targetName = listServerMembers.all(serverId).find((item) => Number(item.user_id) === targetUserId)?.username || `User ${targetUserId}`;
    withTransaction(() => {
      if (action === 'ban') {
        if (isOfficialServer) officialAnnouncements.clearKick(targetUserId);
        insertServerBan.run(serverId, targetUserId, reason, now, user.id);
      } else {
        deleteServerBan.run(serverId, targetUserId);
        if (isOfficialServer) officialAnnouncements.kick(targetUserId, user.id, now);
      }
      deleteServerTimeout.run(serverId, targetUserId);
      removeServerMember.run(serverId, targetUserId);
    });
    writeServerAudit(serverId, user, `member.${action}`, { targetType: 'member', targetId: targetUserId, targetName });
    leaveVoiceRooms(targetUserId);
    sendEvent(targetUserId, 'server-membership', { serverId, action });
    notifyServerMembers(serverId, 'server-updated', { serverId, action: `member-${action}` });
    return sendJson(response, 200, { ok: true, action });
  }

  const memberDeviceBanMatch = path.match(/^\/api\/servers\/(\d+)\/members\/(\d+)\/device-ban$/);
  if (method === 'POST' && memberDeviceBanMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(memberDeviceBanMatch[1]);
    const targetUserId = Number(memberDeviceBanMatch[2]);
    const actor = findServerMember.get(serverId, user.id);
    const target = findServerMember.get(serverId, targetUserId);
    if (!canServerPermission(user, serverId, 'manageMembers')) return sendJson(response, 403, { error: 'Manage members permission required.' });
    if (!target || target.permissions === 'owner' || (actor?.permissions === 'moderator' && target.permissions === 'moderator')) return sendJson(response, 403, { error: 'You cannot moderate this member.' });
    const deviceHashes = listServerMemberDeviceHashes.all(serverId, targetUserId).map((item) => item.device_hash);
    if (!deviceHashes.length) return sendJson(response, 409, { error: 'No Glean installation is known for this member yet. Ask them to open the server and try again.' });
    const currentDeviceHash = serverDeviceHash(request, serverId);
    if (currentDeviceHash && deviceHashes.includes(currentDeviceHash)) return sendJson(response, 409, { error: 'This installation is also being used by your moderator account, so it cannot be banned.' });
    const linkedUsers = listUsersSharingServerDevices.all(serverId, serverId, targetUserId).map((item) => Number(item.user_id));
    for (const linkedUserId of linkedUsers) {
      const linkedMember = findServerMember.get(serverId, linkedUserId);
      if (linkedUserId !== targetUserId && (linkedMember?.permissions === 'owner' || linkedMember?.permissions === 'moderator')) {
        return sendJson(response, 409, { error: 'This installation is shared with a server owner or moderator. Remove that account from the installation before device-banning it.' });
      }
    }
    let input = {};
    try { input = await readJson(request, 2048); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
    const removedMembers = linkedUsers.map((linkedUserId) => {
      const linkedMember = findServerMember.get(serverId, linkedUserId);
      return linkedMember ? { userId: linkedUserId, roleId: Number(linkedMember.role_id) } : null;
    }).filter(Boolean);
    const targetName = listServerMembers.all(serverId).find((item) => Number(item.user_id) === targetUserId)?.username || `User ${targetUserId}`;
    withTransaction(() => {
      for (const deviceHash of deviceHashes) insertServerDeviceBan.run(serverId, deviceHash, reason, now, user.id);
      for (const { userId: linkedUserId } of removedMembers) {
        deleteServerTimeout.run(serverId, linkedUserId);
        removeServerMember.run(serverId, linkedUserId);
      }
    });
    for (const { userId: linkedUserId } of removedMembers) {
      leaveVoiceRooms(linkedUserId, null, serverId);
      sendEvent(linkedUserId, 'server-membership', { serverId, action: 'device-ban' });
    }
    writeServerAudit(serverId, user, 'member.device-banned', {
      targetType: 'member', targetId: targetUserId, targetName,
      details: { installationsBanned: deviceHashes.length, accountsRemoved: removedMembers.length },
    });
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'member-device-ban' });
    return sendJson(response, 200, { ok: true, deviceCount: deviceHashes.length, removedMembers });
  }

  const memberTimeoutMatch = path.match(/^\/api\/servers\/(\d+)\/members\/(\d+)\/timeout$/);
  if (method === 'POST' && memberTimeoutMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const serverId = Number(memberTimeoutMatch[1]);
    const targetUserId = Number(memberTimeoutMatch[2]);
    const actor = findServerMember.get(serverId, user.id);
    const target = findServerMember.get(serverId, targetUserId);
    if (!canServerPermission(user, serverId, 'manageMembers')) return sendJson(response, 403, { error: 'Manage members permission required.' });
    if (!target || target.permissions === 'owner' || (actor?.permissions === 'moderator' && target.permissions === 'moderator')) return sendJson(response, 403, { error: 'You cannot moderate this member.' });
    if (Number(targetUserId) === Number(user.id)) return sendJson(response, 400, { error: 'You cannot timeout yourself.' });
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    const seconds = Number(input.seconds);
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
    if (seconds === 0) {
      deleteServerTimeout.run(serverId, targetUserId);
      const targetName = listServerMembers.all(serverId).find((item) => Number(item.user_id) === targetUserId)?.username || `User ${targetUserId}`;
      writeServerAudit(serverId, user, 'member.timeout-removed', { targetType: 'member', targetId: targetUserId, targetName });
      notifyServerMembers(serverId, 'server-updated', { serverId, action: 'member-timeout', userId: targetUserId, timeoutUntil: null });
      sendEvent(targetUserId, 'server-updated', { serverId, action: 'member-timeout', timeoutUntil: null });
      return sendJson(response, 200, { ok: true, timeoutUntil: null });
    }
    if (!TIMEOUT_SECONDS.has(seconds)) return sendJson(response, 400, { error: 'Choose a supported timeout length.' });
    const until = new Date(Date.now() + seconds * 1000).toISOString();
    upsertServerTimeout.run(serverId, targetUserId, until, reason, user.id, now);
    const targetName = listServerMembers.all(serverId).find((item) => Number(item.user_id) === targetUserId)?.username || `User ${targetUserId}`;
    writeServerAudit(serverId, user, 'member.timed-out', { targetType: 'member', targetId: targetUserId, targetName, details: { until } });
    notifyServerMembers(serverId, 'server-updated', { serverId, action: 'member-timeout', userId: targetUserId, timeoutUntil: until });
    sendEvent(targetUserId, 'server-updated', { serverId, action: 'member-timeout', timeoutUntil: until });
    return sendJson(response, 200, { ok: true, timeoutUntil: until });
  }

  const channelMatch = path.match(/^\/api\/channels\/(\d+)\/messages$/);
  if (method === 'GET' && channelMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const channelId = Number(channelMatch[1]);
    if (!canSeeChannel(user, channelId)) return sendJson(response, 404, { error: 'Channel not found.' });
    if (findChannel.get(channelId)?.voice) return sendJson(response, 400, { error: 'Voice channels do not have messages.' });
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const beforeRaw = Number(url.searchParams.get('before'));
    const before = Number.isInteger(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;
    const requestedLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
    const { messages, page } = listChannelMessagePayloads(channelId, user.id, { before, limit });
    if (isChannelMember.get(channelId, user.id) && !before) applyChannelRead(channelId, user.id);
    return sendJson(response, 200, { messages, page });
  }

const moderationMessageMatch = path.match(/^\/api\/channels\/(\d+)\/messages\/(\d+)$/);
  if (method === 'PATCH' && moderationMessageMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const channelId = Number(moderationMessageMatch[1]);
    const messageId = Number(moderationMessageMatch[2]);
    if (!canSeeChannel(user, channelId)) return sendJson(response, 404, { error: 'Channel not found.' });
    const channelRecord = findChannel.get(channelId);
    const message = findChannelMessage.get(messageId);
    if (!message || message.deleted_at || Number(message.channel_id) !== channelId) return sendJson(response, 404, { error: 'Message not found.' });
    if (Number(message.user_id) !== Number(user.id) && !canServerPermission(user, channelRecord.server_id, 'manageMessages')) return sendJson(response, 403, { error: 'You can only edit your own messages.' });
    if (Number(message.user_id) === Number(user.id) && timeoutUntilFor(Number(channelRecord.server_id), user.id)) return sendJson(response, 403, { error: 'You are timed out in this server.' });
    if (Number(message.user_id) === Number(user.id) && !canServerPermission(user, channelRecord.server_id, 'manageMessages')) {
      const block = postingBlockReason(user, channelRecord, { skipSlowmode: true });
      if (block) return sendJson(response, 403, { error: block });
    }
    const { body } = await readJson(request);
    const cleanBody = String(body || '').trim();
    if (cleanBody.length > 4000) return sendJson(response, 400, { error: 'Message must be 1–4000 characters.' });
    const existingPoll = parseStoredPoll(getChannelMessagePoll.get(messageId)?.poll_json);
    if (!cleanBody && !Number(countChannelAttachmentsForMessage.get(messageId)?.count || 0) && !existingPoll) return sendJson(response, 400, { error: 'Message must be 1–4000 characters.' });
    const textToModerate = moderationText(cleanBody, existingPoll);
    const moderationResult = Number(channelRecord.moderation_enabled) === 1 && textToModerate
      ? await moderateServerMessage(textToModerate, moderationContext(channelId, messageId))
      : null;
    if (moderationResult?.fallbackUsed && moderationResult.action !== 'block') {
      return sendJson(response, 503, { error: 'Automatic moderation is temporarily unavailable. Your edit was not saved. Please try again shortly.' });
    }
    if (moderationResult?.action === 'block') {
      auditModerationResult(channelRecord, user, 'blocked', moderationResult, messageId, 'channel-message');
      return sendJson(response, 422, { error: 'This message was blocked by server moderation. Please edit it and try again.' });
    }
    updateChannelMessage.run(cleanBody, now, messageId);
    if (Number(message.user_id) !== Number(user.id)) writeServerAudit(channelRecord.server_id, user, 'message.moderator-edited', { targetType: 'channel-message', targetId: messageId, targetName: channelRecord.name });
    if (moderationResult && ['warn', 'flag'].includes(moderationResult.action)) auditModerationResult(channelRecord, user, moderationResult.action, moderationResult, messageId, 'channel-message');
    syncChannelMentions(messageId, channelId, cleanBody);
    const payload = channelMessageFullPayload(channelId, messageId, user.id);
    notifyServerMembers(channelRecord.server_id, 'channel-message', { serverId: Number(channelRecord.server_id), channelId, action: 'edited', message: payload });
    return sendJson(response, 200, { message: payload, moderationAction: moderationResult?.action || 'allow' });
  }

  if (method === 'DELETE' && moderationMessageMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const channelId = Number(moderationMessageMatch[1]);
    const messageId = Number(moderationMessageMatch[2]);
    const channelRecord = findChannel.get(channelId);
    const message = findChannelMessage.get(messageId);
    if (!message || message.deleted_at || Number(message.channel_id) !== channelId) return sendJson(response, 404, { error: 'Message not found.' });
    if (!channelRecord || !canSeeChannel(user, channelId) || (Number(message.user_id) !== Number(user.id) && !canServerPermission(user, channelRecord.server_id, 'manageMessages'))) return sendJson(response, 403, { error: 'You can only delete your own messages.' });
    const storedAttachments = listChannelMessageStorage.all(messageId).map((attachment) => attachment.storage_name);
    withTransaction(() => {
      deleteChannelMessageReactions.run(messageId);
      deleteChannelMessageMentions.run(messageId);
      deleteChannelMessagePollVotes.run(messageId);
      deleteChannelMessageAttachments.run(messageId);
      deleteChannelMessage.run(messageId);
    });
    removeStoredUploads(storedAttachments);
    if (Number(message.user_id) !== Number(user.id)) writeServerAudit(channelRecord.server_id, user, 'message.moderator-deleted', { targetType: 'channel-message', targetId: messageId, targetName: channelRecord.name });
    notifyServerMembers(channelRecord.server_id, 'channel-message', { serverId: Number(channelRecord.server_id), channelId, action: 'deleted', messageId });
    return sendJson(response, 200, { ok: true });
  }

  if (method === 'POST' && channelMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const channelId = Number(channelMatch[1]);
    if (!isChannelMember.get(channelId, user.id)) return sendJson(response, 404, { error: 'Channel not found.' });
    const channelRecord = findChannel.get(channelId);
    if (channelRecord?.voice) return sendJson(response, 400, { error: 'Voice channels do not have messages.' });
    let input;
    try { input = await readMessageInput(request); } catch (error) { return sendJson(response, 400, { error: error.message || 'Unable to read attachments.' }); }
    const files = input.files || [];
    const storedNames = files.map((file) => file.storageName).filter(Boolean);
    const cleanBody = String(input.body || '').trim();
    const pollResult = sanitizePoll(input.poll);
    const rejectUpload = (status, error) => {
      removeStoredUploads(storedNames);
      return sendJson(response, status, { error });
    };
    if (pollResult.error) return rejectUpload(400, pollResult.error);
    if (pollResult.poll && files.length) return rejectUpload(400, 'Polls cannot include file attachments.');
    if (cleanBody.length > 4000) return rejectUpload(400, 'Message must be 1–4000 characters.');
    if (!cleanBody && !files.length && !pollResult.poll) return rejectUpload(400, 'Message must include text or a file.');
    if (files.length > 10) return rejectUpload(400, 'You can attach up to 10 files.');
    const totalSize = files.reduce((total, file) => total + Number(file.size || 0), 0);
    if (totalSize > MAX_ATTACHMENT_BYTES || files.some((file) => Number(file.size || 0) > MAX_ATTACHMENT_BYTES)) {
      return rejectUpload(400, 'Each attachment and the total message can be up to 2 GB.');
    }
    for (const file of files) {
      if (!channelFileMimeType(file)) return rejectUpload(400, 'That file type is not allowed.');
    }
    const canRunNuraCommand = files.length === 0 && !pollResult.poll && !input.replyToMessageId;
    const activateCommand = canRunNuraCommand && /^\/activate\s*$/i.test(cleanBody);
    const deactivateCommand = canRunNuraCommand && /^\/deactivate\s*$/i.test(cleanBody);
    const chatCommand = canRunNuraCommand ? cleanBody.match(/^\/chat(?:\s+([\s\S]+))?$/i) : null;
    const isNuraCommand = Boolean(activateCommand || deactivateCommand || chatCommand);
    const block = postingBlockReason(user, channelRecord, { skipSlowmode: isNuraCommand });
    if (block) return rejectUpload(block.startsWith('Slowmode') ? 429 : 403, block);
    const reply = requireChannelReply(channelId, input.replyToMessageId);
    if (reply.error) return rejectUpload(400, reply.error);
    if (activateCommand || deactivateCommand || chatCommand) {
      if (!serverHasNura.get(Number(channelRecord.server_id))) return rejectUpload(409, 'Nura has not been added to this server. Ask the server owner to add Nura in Server Settings → Bots.');
      if (chatCommand && !String(chatCommand[1] || '').trim()) return rejectUpload(400, 'Use /chat followed by your message.');
      if (chatCommand && nuraServerRepliesInFlight.has(channelId)) return rejectUpload(429, 'Nura is already replying in this channel. Try /chat again in a moment.');
      if (activateCommand || deactivateCommand) {
        const commandBlock = postingBlockReason(user, channelRecord, { skipSlowmode: true });
        if (commandBlock) return rejectUpload(commandBlock.startsWith('Slowmode') ? 429 : 403, commandBlock);
        const active = Boolean(Number(getNuraChannelActivation.get(channelId)?.active));
        const nextActive = activateCommand;
        upsertNuraChannelActivation.run(Number(channelRecord.server_id), channelId, Number(nextActive), user.id, new Date().toISOString());
        writeServerAudit(channelRecord.server_id, user, nextActive ? 'bot.channel-activated' : 'bot.channel-deactivated', { targetType: 'channel', targetId: channelId, targetName: channelRecord.name, details: { botId: 'nura', changed: active !== nextActive } });
        notifyServerMembers(channelRecord.server_id, 'server-updated', { serverId: Number(channelRecord.server_id), action: 'bot-channel-updated', channelId, botId: 'nura', active: nextActive });
        const statusText = nextActive
          ? (active ? 'auto-reply is already active in this channel.' : `auto-reply mode activated. messages in #${channelRecord.name} will be sent to groq so i can reply. use /deactivate to turn it off.`)
          : (active ? 'auto-reply mode deactivated for this channel.' : 'auto-reply is already off in this channel.');
        const message = await postNuraServerMessage(channelId, Number(channelRecord.server_id), statusText);
        const updatedRow = listServerChannels.all(Number(channelRecord.server_id)).find((item) => Number(item.id) === channelId);
        return sendJson(response, 200, { message, command: activateCommand ? 'activate' : 'deactivate', channel: updatedRow ? publicChannel(updatedRow) : null });
      }
    }
    const textToModerate = moderationText(cleanBody, pollResult.poll);
    const moderationResult = Number(channelRecord.moderation_enabled) === 1 && textToModerate
      ? await moderateServerMessage(textToModerate, moderationContext(channelId))
      : null;
    if (moderationResult?.fallbackUsed && moderationResult.action !== 'block') return rejectUpload(503, 'Automatic moderation is temporarily unavailable. Your message was not sent. Please try again shortly.');
    if (moderationResult?.action === 'block') {
      auditModerationResult(channelRecord, user, 'blocked', moderationResult);
      return rejectUpload(422, 'This message was blocked by server moderation. Please edit it and try again.');
    }
    if (!isChannelMember.get(channelId, user.id)) return rejectUpload(404, 'Channel not found.');
    const currentBlock = postingBlockReason(user, findChannel.get(channelId), { skipSlowmode: isNuraCommand });
    if (currentBlock) return rejectUpload(currentBlock.startsWith('Slowmode') ? 429 : 403, currentBlock);
    let messageId;
    const committedAt = new Date().toISOString();
    try {
      withTransaction(() => {
        messageId = Number(insertChannelMessage.run(channelId, user.id, cleanBody, committedAt, reply.id, pollResult.poll ? JSON.stringify(pollResult.poll) : null).lastInsertRowid);
        for (const file of files) {
          insertChannelAttachment.run(messageId, channelId, user.id, file.storageName, safeFileName(file.name), channelFileMimeType(file), Number(file.size || 0), committedAt);
        }
        syncChannelMentions(messageId, channelId, cleanBody);
        upsertChannelRead.run(channelId, user.id, messageId);
      });
    } catch (error) {
      removeStoredUploads(storedNames);
      return sendJson(response, 400, { error: error.message || 'Unable to save that attachment.' });
    }
    if (moderationResult && ['warn', 'flag'].includes(moderationResult.action)) auditModerationResult(channelRecord, user, moderationResult.action, moderationResult, messageId, 'channel-message');
    const payload = channelMessageFullPayload(channelId, messageId, user.id);
    notifyChannelMessageCreated(channelRecord.server_id, { serverId: Number(channelRecord.server_id), channelId, action: 'created', message: payload }, user.id);
    pushServerMembers(channelRecord.server_id, {
      kind: 'channel',
      messageId,
      title: `${user.username} in #${channelRecord.name}`,
      body: files.length && !cleanBody ? 'Sent an attachment' : previewText(cleanBody, pollResult.poll ? pollResult.poll.question : 'New message'),
      icon: user.avatar_url || '/icon-192.png',
      url: `/servers?s=${channelRecord.server_id}&ch=${channelId}`,
      tag: `ch:${channelId}`,
      serverId: Number(channelRecord.server_id),
      channelId,
    }, user.id);
    if (chatCommand || (serverHasNura.get(Number(channelRecord.server_id)) && Number(getNuraChannelActivation.get(channelId)?.active))) {
      const promptText = chatCommand ? String(chatCommand[1] || '').trim() : '';
      setImmediate(() => { void answerWithNuraInServer({ channelId, serverId: Number(channelRecord.server_id), authorId: Number(user.id), promptText }); });
    }
    return sendJson(response, 201, { message: payload, moderationAction: moderationResult?.action || 'allow' });
  }

  const reactionMatch = path.match(/^\/api\/channels\/(\d+)\/messages\/(\d+)\/reactions$/);
  if (method === 'POST' && reactionMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const channelId = Number(reactionMatch[1]);
    const messageId = Number(reactionMatch[2]);
    if (!isChannelMember.get(channelId, user.id)) return sendJson(response, 404, { error: 'Channel not found.' });
    const message = findChannelMessage.get(messageId);
    if (!message || message.deleted_at || Number(message.channel_id) !== channelId) return sendJson(response, 404, { error: 'Message not found.' });
    const { emoji } = await readJson(request);
    const cleanEmoji = String(emoji || '').trim();
    if (!cleanEmoji || cleanEmoji.length > 16 || !/\p{Extended_Pictographic}/u.test(cleanEmoji)) return sendJson(response, 400, { error: 'That reaction is not supported.' });
    if (findChannelReaction.get(messageId, user.id, cleanEmoji)) deleteChannelReaction.run(messageId, user.id, cleanEmoji);
    else insertChannelReaction.run(messageId, user.id, cleanEmoji, now);
    const payload = channelMessageFullPayload(channelId, messageId, user.id);
    const serverId = Number(findChannel.get(channelId).server_id);
    notifyServerMembers(serverId, 'channel-message', { serverId, channelId, action: 'reaction', message: payload });
    return sendJson(response, 200, { message: payload });
  }

  const pollVotersMatch = path.match(/^\/api\/channels\/(\d+)\/messages\/(\d+)\/poll\/voters$/);
  if (method === 'GET' && pollVotersMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const channelId = Number(pollVotersMatch[1]), messageId = Number(pollVotersMatch[2]);
    const message = findChannelMessage.get(messageId);
    if (!canSeeChannel(user, channelId) || !message || message.deleted_at || Number(message.channel_id) !== channelId) return sendJson(response, 404, { error: 'Poll not found.' });
    const poll = parseStoredPoll(getChannelMessagePoll.get(messageId)?.poll_json);
    if (!poll) return sendJson(response, 404, { error: 'Poll not found.' });
    const url = new URL(request.url, 'http://localhost');
    const option = Number(url.searchParams.get('option')), after = Number(url.searchParams.get('after') || 0);
    if (!Number.isInteger(option) || option < 0 || option >= poll.options.length || !Number.isSafeInteger(after) || after < 0) return sendJson(response, 400, { error: 'Invalid voter page.' });
    const rows = database.prepare('SELECT users.id, users.username, users.avatar_url AS avatarUrl FROM channel_poll_votes v JOIN users ON users.id = v.user_id WHERE v.message_id = ? AND v.option_index = ? AND v.user_id > ? ORDER BY v.user_id LIMIT 51').all(messageId, option, after);
    return sendJson(response, 200, { voters: rows.slice(0, 50), next: rows.length > 50 ? Number(rows[49].id) : null });
  }
  const pollVoteMatch = path.match(/^\/api\/channels\/(\d+)\/messages\/(\d+)\/poll\/vote$/);
  if (method === 'POST' && pollVoteMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const channelId = Number(pollVoteMatch[1]);
    const messageId = Number(pollVoteMatch[2]);
    if (!isChannelMember.get(channelId, user.id)) return sendJson(response, 404, { error: 'Channel not found.' });
    const channelRecord = findChannel.get(channelId);
    if (channelRecord?.voice) return sendJson(response, 400, { error: 'Voice channels do not have messages.' });
    const message = findChannelMessage.get(messageId);
    if (!message || message.deleted_at || Number(message.channel_id) !== channelId) return sendJson(response, 404, { error: 'Message not found.' });
    const stored = parseStoredPoll(getChannelMessagePoll.get(messageId)?.poll_json);
    if (!stored) return sendJson(response, 400, { error: 'That message is not a poll.' });
    if (stored.closed) return sendJson(response, 400, { error: 'This poll is closed.' });
    const { optionIndex } = await readJson(request);
    const index = Number(optionIndex);
    if (!Number.isInteger(index) || index < 0 || index >= stored.options.length) return sendJson(response, 400, { error: 'That poll option is not valid.' });
    withTransaction(() => {
      if (stored.allowMultiple) {
        if (findPollVote.get(messageId, user.id, index)) deletePollVote.run(messageId, user.id, index);
        else insertPollVote.run(messageId, user.id, index, now);
      } else {
        deleteUserPollVotes.run(messageId, user.id);
        insertPollVote.run(messageId, user.id, index, now);
      }
    });
    const payload = channelMessageFullPayload(channelId, messageId, user.id);
    notifyChannelPoll(channelRecord.server_id, channelId, messageId);
    return sendJson(response, 200, { message: payload });
  }

  const pollCloseMatch = path.match(/^\/api\/channels\/(\d+)\/messages\/(\d+)\/poll\/close$/);
  if (method === 'POST' && pollCloseMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const channelId = Number(pollCloseMatch[1]);
    const messageId = Number(pollCloseMatch[2]);
    if (!canSeeChannel(user, channelId)) return sendJson(response, 404, { error: 'Channel not found.' });
    const channelRecord = findChannel.get(channelId);
    const message = findChannelMessage.get(messageId);
    if (!message || message.deleted_at || Number(message.channel_id) !== channelId) return sendJson(response, 404, { error: 'Message not found.' });
    if (Number(message.user_id) !== Number(user.id) && !canServerPermission(user, channelRecord.server_id, 'manageMessages')) return sendJson(response, 403, { error: 'You can only close your own polls.' });
    const stored = parseStoredPoll(getChannelMessagePoll.get(messageId)?.poll_json);
    if (!stored) return sendJson(response, 400, { error: 'That message is not a poll.' });
    if (!stored.closed) updateChannelPoll.run(JSON.stringify({ ...stored, closed: true, closedAt: now }), messageId);
    const payload = channelMessageFullPayload(channelId, messageId, user.id);
    notifyChannelPoll(channelRecord.server_id, channelId, messageId);
    return sendJson(response, 200, { message: payload });
  }

  const directMatch = path.match(/^\/api\/conversations\/direct\/([^/]+)$/);
  if (method === 'POST' && directMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const friend = findPublicUserByUsername.get(usernameFromPathSegment(directMatch[1]));
    if (!friend || !areFriends(user.id, friend.id) || isBlockedEither(user.id, friend.id)) return sendJson(response, 403, { error: 'You can only message accepted friends.' });
    const conversationId = createDirectConversation(user.id, friend.id, now);
    sendEvent(user.id, 'conversations', { conversationId });
    sendEvent(friend.id, 'conversations', { conversationId });
    return sendJson(response, 200, { conversation: { id: conversationId, user: { id: Number(friend.id), username: friend.username, publicKey: safeJsonParse(friend.public_key_jwk), keyFingerprint: friend.key_fingerprint || null } } });
  }

  const conversationReadMatch = path.match(/^\/api\/conversations\/(\d+)\/read$/);
  if (method === 'POST' && conversationReadMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const conversationId = Number(conversationReadMatch[1]);
    if (!isConversationMember.get(conversationId, user.id)) return sendJson(response, 404, { error: 'Conversation not found.' });
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    applyConversationRead(conversationId, user.id, input.lastReadMessageId);
    return sendJson(response, 200, unreadStateFor(user.id, { ok: true, conversationId, unreadCount: conversationUnreadCount(conversationId, user.id) }));
  }

  const channelReadMatch = path.match(/^\/api\/channels\/(\d+)\/read$/);
  if (method === 'POST' && channelReadMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const channelId = Number(channelReadMatch[1]);
    const channelRecord = findChannel.get(channelId);
    if (!channelRecord) return sendJson(response, 404, { error: 'Channel not found.' });
    if (channelRecord.voice) return sendJson(response, 400, { error: 'Voice channels do not have messages.' });
    if (!isChannelMember.get(channelId, user.id)) {
      if (canSeeChannel(user, channelId)) return sendJson(response, 403, { error: 'Only members can mark this channel read.' });
      return sendJson(response, 404, { error: 'Channel not found.' });
    }
    let input = {};
    try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
    applyChannelRead(channelId, user.id, input.lastReadMessageId);
    const map = channelUnreadMap(user.id);
    const channel = map.channels.get(channelId) || { unreadCount: 0, mentionCount: 0 };
    const server = map.servers.get(Number(channelRecord.server_id)) || { unread: false, unreadCount: 0, mentionCount: 0 };
    return sendJson(response, 200, unreadStateFor(user.id, {
      ok: true,
      serverId: Number(channelRecord.server_id),
      channelId,
      unreadCount: channel.unreadCount,
      mentionCount: channel.mentionCount,
      serverUnread: server.unread,
      serverUnreadCount: server.unreadCount,
      serverMentionCount: server.mentionCount,
    }));
  }

  const messageMatch = path.match(/^\/api\/conversations\/(\d+)\/messages$/);
  if (messageMatch && method === 'GET') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const conversationId = Number(messageMatch[1]);
    if (!isConversationMember.get(conversationId, user.id)) return sendJson(response, 404, { error: 'Conversation not found.' });
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const beforeRaw = Number(url.searchParams.get('before'));
    const before = Number.isInteger(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;
    const requestedLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
    const historyStart = groupDms.historyStart(conversationId, user.id);
    const rows = before
      ? listMessages.all(conversationId, before, historyStart, limit + 1)
      : listLatestMessages.all(conversationId, historyStart, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    const attachments = attachmentsByMessageIds(page.map((row) => row.id));
    const messages = page.map((row) => {
      const message = directMessagePayload(row, attachments.get(Number(row.id)) || []);
      if (message.replyTo && message.replyTo.id <= historyStart) message.replyTo = { id: message.replyTo.id, body: '', deleted: true };
      return message;
    });
    if (!before) applyConversationRead(conversationId, user.id);
    return sendJson(response, 200, { messages, page: { hasMore, nextBefore: hasMore ? Number(page[0]?.id || 0) : null } });
  }

  const dmMessageItemMatch = path.match(/^\/api\/conversations\/(\d+)\/messages\/(\d+)$/);
  if (dmMessageItemMatch && method === 'PATCH') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const conversationId = Number(dmMessageItemMatch[1]);
    const messageId = Number(dmMessageItemMatch[2]);
    if (!isConversationMember.get(conversationId, user.id)) return sendJson(response, 404, { error: 'Conversation not found.' });
    const existing = findDirectMessage.get(messageId);
    if (!existing || Number(existing.conversation_id) !== conversationId || existing.deleted_at) return sendJson(response, 404, { error: 'Message not found.' });
    if (Number(existing.sender_id) !== Number(user.id)) return sendJson(response, 403, { error: 'You can only edit your own messages.' });
    if (Number(existing.encryption_version || 0) > 0) return sendJson(response, 400, { error: 'Encrypted messages cannot be edited.' });
    const { body } = await readJson(request);
    const cleanBody = String(body || '').trim();
    if (cleanBody.length > 4000) return sendJson(response, 400, { error: 'Message must be 1–4000 characters.' });
    if (!cleanBody && !listAttachmentsForMessage.all(messageId).length) return sendJson(response, 400, { error: 'Message must be 1–4000 characters.' });
    updateDirectMessage.run(cleanBody, now, messageId);
    const message = directMessagePayload(loadDirectMessageRow.get(messageId));
    notifyDirectMessage(conversationId, message, user.id, 'edited');
    return sendJson(response, 200, { message });
  }

  if (dmMessageItemMatch && method === 'DELETE') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const conversationId = Number(dmMessageItemMatch[1]);
    const messageId = Number(dmMessageItemMatch[2]);
    if (!isConversationMember.get(conversationId, user.id)) return sendJson(response, 404, { error: 'Conversation not found.' });
    const existing = findDirectMessage.get(messageId);
    if (!existing || Number(existing.conversation_id) !== conversationId || existing.deleted_at) return sendJson(response, 404, { error: 'Message not found.' });
    if (Number(existing.sender_id) !== Number(user.id)) return sendJson(response, 403, { error: 'You can only delete your own messages.' });
    softDeleteDirectMessage.run(now, messageId);
    notifyDirectMessage(conversationId, { id: messageId }, user.id, 'deleted');
    return sendJson(response, 200, { ok: true });
  }

  if (messageMatch && method === 'POST') {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const conversationId = Number(messageMatch[1]);
    if (!isConversationMember.get(conversationId, user.id)) return sendJson(response, 404, { error: 'Conversation not found.' });
    const isGroup = groupDms.isGroup(conversationId);
    const peer = isGroup ? { is_bot: 0 } : findConversationPeer.get(conversationId, user.id);
    if (!peer) return sendJson(response, 409, { error: 'Conversation participant is unavailable.' });
    if (!isGroup && isBlockedEither(user.id, peer.id)) return sendJson(response, 403, { error: "You can't message this person." });
    let input;
    try { input = await readMessageInput(request); } catch (error) { return sendJson(response, 400, { error: error.message || 'Unable to read attachments.' }); }
    const reply = requireDirectReply(conversationId, input.replyToMessageId);
    const { envelope, attachmentMeta = [], files } = input;
    const storedNames = files.map((file) => file.storageName).filter(Boolean);
    const dropUploads = () => removeStoredUploads(storedNames);
    if (isGroup) {
      try {
        groupDms.validateEnvelope(conversationId, user, envelope);
        if (reply.id && reply.id <= groupDms.historyStart(conversationId, user.id)) throw Object.assign(new Error('That message cannot be replied to.'), { status: 400 });
      } catch (error) {
        dropUploads();
        if (!error.status) throw error;
        return sendJson(response, error.status, { error: error.message });
      }
    }
    if (peer.is_bot && envelope) {
      dropUploads();
      return sendJson(response, 400, { error: 'Nura chats are processed by Groq and are not end-to-end encrypted. Refresh Glean and try again.' });
    }
    if (reply.error) {
      dropUploads();
      return sendJson(response, 400, { error: reply.error });
    }
    const cleanBody = String(input.body || '').trim();
    if (!envelope) {
      if (cleanBody.length > 4000) { dropUploads(); return sendJson(response, 400, { error: 'Message must be 1–4000 characters.' }); }
      if (!cleanBody && !files.length) { dropUploads(); return sendJson(response, 400, { error: 'Message must include text or a file.' }); }
      if (files.length > 10) { dropUploads(); return sendJson(response, 400, { error: 'You can attach up to 10 files.' }); }
      const totalSize = files.reduce((total, file) => total + Number(file.size || 0), 0);
      if (totalSize > MAX_ATTACHMENT_BYTES || files.some((file) => Number(file.size || 0) > MAX_ATTACHMENT_BYTES)) {
        dropUploads();
        return sendJson(response, 400, { error: 'Each attachment and the total message can be up to 2 GB.' });
      }
      let nuraImageFiles = [];
      if (Number(peer.is_bot)) {
        if (files.length > NURA_MAX_IMAGES) {
          dropUploads();
          return sendJson(response, 400, { error: `Nura supports up to ${NURA_MAX_IMAGES} images per message.` });
        }
        try {
          for (const file of files) {
            const mimeType = sanitizeMimeType(file.type).toLowerCase();
            if (!NURA_IMAGE_TYPES.has(mimeType)) throw new Error('Nura can read JPEG, PNG, and WebP images only. Video and other file attachments are not supported.');
            if (Number(file.size || 0) < 1 || Number(file.size || 0) > NURA_MAX_IMAGE_BYTES) throw new Error('Each image sent to Nura must be 20 MB or smaller.');
            const bytes = await readFile(join(uploadDirectory, file.storageName));
            const metadata = await sharp(bytes, { animated: false }).metadata();
            const expectedFormat = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }[mimeType];
            if (metadata.format !== expectedFormat) throw new Error('One attachment is not a valid JPEG, PNG, or WebP image.');
            nuraImageFiles.push({ mimeType, bytes });
          }
        } catch (error) {
          dropUploads();
          return sendJson(response, 400, { error: error.message || 'Nura could not read one of those images.' });
        }
      }
      let messageId;
      try {
        withTransaction(() => {
          if (messageReports.getRestriction(user.id)) throw Object.assign(new Error('Your account is restricted. Reload to view the expiration.'), { status: 403 });
          messageId = Number(insertMessage.run(conversationId, user.id, cleanBody, null, null, null, null, null, null, 0, now, reply.id).lastInsertRowid);
          for (const file of files) {
            insertAttachment.run(messageId, conversationId, user.id, file.storageName, safeFileName(file.name), sanitizeMimeType(file.type) || 'application/octet-stream', Number(file.size || 0), 0, null, null, null, null, now);
          }
          markConversationRead.run(messageId, messageId, conversationId, user.id);
        });
      } catch (error) {
        dropUploads();
        return sendJson(response, error.status || 400, { error: error.message || 'Unable to save that attachment.' });
      }
      const message = directMessagePayload(loadDirectMessageRow.get(messageId));
      notifyDirectMessage(conversationId, message, user.id);
      pushConversationMembers(conversationId, {
        kind: 'dm',
        title: user.username,
        body: files.length && !cleanBody ? 'Sent an attachment' : previewText(cleanBody, 'Sent you a message'),
        icon: user.avatar_url || '/icon-192.png',
        url: `/dms?c=${conversationId}`,
        tag: `dm:${conversationId}`,
        conversationId,
      }, user.id);
      if (Number(peer.is_bot)) setImmediate(() => { void answerWithNura(conversationId, Number(user.id), nuraImageFiles); });
      return sendJson(response, 201, { message });
    }
    if (!user.public_key_jwk || (!isGroup && !peer.public_key_jwk)) { dropUploads(); return sendJson(response, 409, { error: 'All participants must initialize private-message encryption first.' }); }
    if (!envelope || Number(envelope.version) !== (isGroup ? 2 : 1)) { dropUploads(); return sendJson(response, 400, { error: 'Private messages must use Glean end-to-end encryption.' }); }
    const clientMessageId = String(envelope.clientMessageId || '');
    if (!/^[a-zA-Z0-9_-]{16,96}$/.test(clientMessageId)) { dropUploads(); return sendJson(response, 400, { error: 'Invalid client message ID.' }); }
    const existing = findMessageByClientId.get(conversationId, user.id, clientMessageId);
    if (existing) {
      dropUploads();
      const saved = loadDirectMessageRow.get(existing.id);
      if (!saved || saved.deleted_at) return sendJson(response, 409, { error: 'This message was already deleted.' });
      return sendJson(response, 200, { duplicate: true, messageId: Number(existing.id), message: directMessagePayload(saved) });
    }

    const ciphertext = String(envelope.ciphertext || '');
    const iv = String(envelope.iv || '');
    const salt = String(envelope.salt || '');
    const senderPublicKey = JSON.stringify(envelope.senderPublicKey || {});
    const recipientPublicKey = JSON.stringify(envelope.recipientPublicKey || {});
    if (!ciphertext || ciphertext.length > 64_000 || !/^[A-Za-z0-9_-]+$/.test(ciphertext)) { dropUploads(); return sendJson(response, 400, { error: 'Invalid encrypted message payload.' }); }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(iv) || !/^[A-Za-z0-9_-]{16,96}$/.test(salt)) { dropUploads(); return sendJson(response, 400, { error: 'Invalid encryption parameters.' }); }
    if (!isGroup && (!publicKeyMatchesStored(envelope.senderPublicKey, user.public_key_jwk, user.key_fingerprint)
      || !publicKeyMatchesStored(envelope.recipientPublicKey, peer.public_key_jwk, peer.key_fingerprint))) {
      dropUploads();
      return sendJson(response, 409, { error: 'Encryption keys changed. Refresh the conversation and try again.' });
    }
    if (files.length > 10 || attachmentMeta.length !== files.length) { dropUploads(); return sendJson(response, 400, { error: 'Invalid encrypted attachments.' }); }
    const encryptedTotal = files.reduce((total, file) => total + Number(file.size || 0), 0);
    if (encryptedTotal > MAX_ATTACHMENT_BYTES || files.some((file) => Number(file.size || 0) > MAX_ATTACHMENT_BYTES)) {
      dropUploads();
      return sendJson(response, 400, { error: 'Each encrypted attachment and the total message can be up to 2 GB.' });
    }

    let messageId;
    try {
      withTransaction(() => {
        if (messageReports.getRestriction(user.id)) throw Object.assign(new Error('Your account is restricted. Reload to view the expiration.'), { status: 403 });
        messageId = Number(insertMessage.run(conversationId, user.id, '', ciphertext, iv, salt, senderPublicKey, recipientPublicKey, clientMessageId, isGroup ? 2 : 1, now, reply.id).lastInsertRowid);
        if (isGroup) updateMessageGroupKeys.run(JSON.stringify(envelope.recipientKeys), messageId);
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index];
          const meta = attachmentMeta[index] || {};
          const fileIv = String(meta.iv || '');
          const fileSalt = String(meta.salt || '');
          if (!/^[A-Za-z0-9_-]{16,64}$/.test(fileIv) || !/^[A-Za-z0-9_-]{16,96}$/.test(fileSalt)) throw new Error('Invalid encrypted attachment metadata.');
          insertAttachment.run(messageId, conversationId, user.id, file.storageName, safeFileName(meta.name || 'encrypted-file'), String(meta.type || 'application/octet-stream').slice(0, 160), Number(meta.size || file.size || 0), 1, fileIv, fileSalt, senderPublicKey, recipientPublicKey, now);
        }
        markConversationRead.run(messageId, messageId, conversationId, user.id);
      });
    } catch (error) {
      dropUploads();
      return sendJson(response, error.status || 400, { error: error.message || 'Unable to save that encrypted attachment.' });
    }
    const message = directMessagePayload(loadDirectMessageRow.get(messageId));
    notifyDirectMessage(conversationId, message, user.id);
    pushConversationMembers(conversationId, {
      kind: 'dm',
      title: isGroup ? groupDms.nameOf(conversationId) : user.username,
      body: isGroup ? `${user.username}: ${files.length ? 'Sent an attachment' : 'Sent a message'}` : files.length ? 'Sent an attachment' : 'Sent you a message',
      icon: user.avatar_url || '/icon-192.png',
      url: `/dms?c=${conversationId}`,
      tag: `dm:${conversationId}`,
      conversationId,
    }, user.id);
    return sendJson(response, 201, { message });
  }

  const attachmentMatch = path.match(/^\/api\/attachments\/(\d+)$/);
  if (method === 'GET' && attachmentMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const attachment = findAttachmentForMember.get(Number(attachmentMatch[1]), user.id);
    if (!attachment) return sendJson(response, 404, { error: 'Attachment not found.' });
    const filePath = join(uploadDirectory, attachment.storage_name);
    if (!existsSync(filePath)) return sendJson(response, 404, { error: 'Attachment file is unavailable.' });
    const preview = !attachment.encrypted && (isPreviewable(attachment.mime_type) || attachment.mime_type.startsWith('audio/') || attachment.mime_type.startsWith('video/') || attachment.mime_type === 'application/pdf' || attachment.mime_type === 'text/plain');
    const fileName = safeFileName(attachment.original_name).replace(/"/g, '');
    return sendLocalFile(request, response, filePath, {
      type: attachment.encrypted ? 'application/octet-stream' : attachment.mime_type,
      extra: {
        'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename="${fileName}${attachment.encrypted ? '.glean-encrypted' : ''}"`,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  const channelAttachmentMatch = path.match(/^\/api\/channel-attachments\/(\d+)$/);
  if (method === 'GET' && channelAttachmentMatch) {
    const user = requireSignedInUser(request, response);
    if (!user) return;
    const attachment = findChannelAttachmentForMember.get(Number(channelAttachmentMatch[1]), user.id)
      || (isPlatformAdmin(user) ? findChannelAttachmentById.get(Number(channelAttachmentMatch[1])) : null);
    if (!attachment) return sendJson(response, 404, { error: 'Attachment not found.' });
    const filePath = join(uploadDirectory, attachment.storage_name);
    if (!existsSync(filePath)) return sendJson(response, 404, { error: 'Attachment file is unavailable.' });
    const mimeType = attachment.mime_type;
    const preview = isPreviewable(mimeType) || mimeType.startsWith('audio/') || mimeType.startsWith('video/') || mimeType === 'application/pdf' || mimeType === 'text/plain';
    const fileName = safeFileName(attachment.original_name).replace(/"/g, '');
    return sendLocalFile(request, response, filePath, {
      type: mimeType,
      extra: {
        'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename="${fileName}"`,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  return sendJson(response, 404, { error: 'Not found.' });
}

function serveProductionFile(request, response) {
  const requestPath = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
  const distRoot = join(rootDirectory, 'dist');
  const fallbackPath = join(distRoot, 'index.html');
  let filePath = fallbackPath;
  try {
    const candidate = resolve(distRoot, `.${decodeURIComponent(requestPath === '/' ? '/index.html' : requestPath)}`);
    if ((candidate === distRoot || candidate.startsWith(`${distRoot}${sep}`)) && existsSync(candidate) && statSync(candidate).isFile()) filePath = candidate;
  } catch { filePath = fallbackPath; }
  const contentTypes = {
    '.css': 'text/css',
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.webmanifest': 'application/manifest+json',
  };
  const fileName = filePath.split(sep).pop();
  const type = contentTypes[extname(filePath)] || 'application/octet-stream';
  const binary = type.startsWith('image/') || type === 'application/pdf';
  const noCache = fileName === 'index.html' || fileName === 'sw.js' || fileName === 'manifest.webmanifest' || fileName === 'blocked.css' || fileName === 'blocked-countdown.js';
  return sendLocalFile(request, response, filePath, {
    type: binary ? type : `${type}; charset=utf-8`,
    extra: {
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=31536000, immutable',
      ...(fileName === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
    },
    gzipText: !binary,
  });
}

let vite;
if (!isProduction) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({
    server: { middlewareMode: true, allowedHosts: true },
    appType: 'spa',
  });
}

const server = createServer(async (request, response) => {
  const id = requestId();
  applySecurityHeaders(response, { production: isProduction });
  response.setHeader('X-Request-Id', id);
  try {
    const requestPath = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
    if (requestPath === '/admin' || requestPath === '/admin/' || requestPath === '/admin.js') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return response.end('Not found.');
    }
    if (requestPath === '/api/access/status' || requestPath === '/api/v1/access/status') {
      if (request.method !== 'GET') {
        response.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Allow: 'GET' });
        return response.end(JSON.stringify({ error: 'Method not allowed.' }));
      }
      const access = currentSchoolAccess();
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
      return response.end(JSON.stringify(access));
    }
    const scheduleAsset = request.method === 'GET' && (requestPath === '/blocked.css' || requestPath === '/blocked-countdown.js');
    const access = currentSchoolAccess();
    if (!access.available && !scheduleAsset) return sendSchoolBlocked(response, access);
    if (request.url?.startsWith('/api/')) return await handleApi(request, response);
    if (!loopRoutesEnabled && (requestPath === '/loop' || requestPath.startsWith('/loop/'))) return sendJson(response, 404, { error: 'Not found.' });
    if (vite) return vite.middlewares(request, response, () => {});
    return serveProductionFile(request, response);
  } catch (error) {
    console.error(`[${id}]`, error);
    if (!response.headersSent) return sendJson(response, 500, { error: 'Something went wrong. Please try again.', requestId: id });
    response.destroy();
  }
});
server.requestTimeout = 180_000;
server.headersTimeout = 70_000;
server.keepAliveTimeout = 65_000;
server.on('connection', (socket) => {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);
});
server.on('upgrade', (request, socket, head) => {
  const access = currentSchoolAccess();
  if (access.offlineScreen) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 300\r\n\r\n');
    return socket.destroy();
  }
  if (!access.available) {
    const retryAfter = Math.max(1, Math.ceil((access.nextOpenAt - Date.now()) / 1000));
    socket.write(`HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: ${retryAfter}\r\n\r\n`);
    return socket.destroy();
  }
  realtimeHub.upgrade(request, socket, head);
});

let previousAccessAvailable = currentSchoolAccess().available;
const scheduleTransitionTimer = setInterval(() => {
  const access = currentSchoolAccess();
  if (previousAccessAvailable && !access.available) {
    realtimeHub.broadcastAll('school-access-blocked', { nextOpenAt: access.nextOpenAt });
    realtimeHub.closeAll(1008, 'Glean is blocked during school hours');
  }
  previousAccessAvailable = access.available;
}, 1000);
scheduleTransitionTimer.unref?.();

function shutdown(signal) {
  console.log(`\n${signal}: closing Glean server...`);
  clearInterval(scheduleTransitionTimer);
  realtimeHub.close();
  presenceBatch.close();
  const loopStopped = loopService.close();
  server.close(async () => { try { await loopStopped; database.close(); } finally { process.exit(0); } });
  setTimeout(() => process.exit(1), 8_000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

const listenHost = String(process.env.GLEAN_HOST || '').trim();
server.listen({ ...(listenHost ? { host: listenHost } : {}), port, backlog: 2048 }, () => console.log(`Glean running at http://localhost:${port} (${isProduction ? 'production' : 'development'})`));
