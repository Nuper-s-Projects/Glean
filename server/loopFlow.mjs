export function createLoopFlow(database, visibility) {
  // Stable random ranks make continuation indexed instead of sorting the entire feed on every swipe.
  try { database.exec('ALTER TABLE loop_posts ADD COLUMN flow_rank INTEGER NOT NULL DEFAULT 0'); }
  catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
  database.exec(`
    UPDATE loop_posts SET flow_rank=(random() & 2147483647)+1 WHERE flow_rank=0;
    CREATE INDEX IF NOT EXISTS loop_flow_rank_idx ON loop_posts(flow_rank,id) WHERE deleted_at IS NULL;
    CREATE TRIGGER IF NOT EXISTS loop_flow_rank_insert AFTER INSERT ON loop_posts WHEN NEW.flow_rank=0
      BEGIN UPDATE loop_posts SET flow_rank=(random() & 2147483647)+1 WHERE id=NEW.id; END;
  `);
  const integer = value => Number.isSafeInteger(value) && value > 0;
  const rank = value => integer(value) && value <= 2147483648;
  const encode = state => Buffer.from(JSON.stringify(state)).toString('base64url');
  const invalid = () => Object.assign(new Error('Flow paging is invalid. Reopen Flow to start again.'), { status: 400 });
  return (viewer, query) => {
    const feed = query.get('feed') || 'everyone';
    const limit = Number(query.get('limit') || 12);
    const avoid = Number(query.get('avoid') || 0);
    if (!['everyone','following'].includes(feed) || !Number.isInteger(limit) || limit < 1 || limit > 30
      || !Number.isSafeInteger(avoid) || avoid < 0) throw invalid();
    const following = feed === 'following' ? 'AND EXISTS(SELECT 1 FROM loop_follows f WHERE f.follower_id=? AND f.followed_id=p.user_id)' : '';
    const eligible = `p.deleted_at IS NULL AND ${visibility} ${following}`;
    const bindings = [viewer, viewer, viewer, ...(feed === 'following' ? [viewer] : [])];
    let state;
    const cursor = query.get('cursor');
    if (query.has('cursor')) {
      if (!cursor || cursor.length > 512 || !/^[\w-]+$/.test(cursor)) throw invalid();
      try { state = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw invalid(); }
      if (!state || state.v !== 1 || state.viewer !== viewer || state.feed !== feed || !integer(state.max)
        || !rank(state.pivotRank) || !integer(state.pivotId) || state.pivotId > state.max
        || !rank(state.lastRank) || !integer(state.lastId) || state.lastId > state.max || typeof state.wrapped !== 'boolean') throw invalid();
      const pastPivot = state.lastRank > state.pivotRank || (state.lastRank === state.pivotRank && state.lastId >= state.pivotId);
      if (pastPivot === state.wrapped) throw invalid();
    } else {
      const max = Number(database.prepare('SELECT MAX(id) id FROM loop_posts').get().id || 0);
      // Random selection happens once per round and only scans IDs, not media or post bodies.
      const pick = excluded => database.prepare(`SELECT p.id,p.flow_rank FROM loop_posts p WHERE ${eligible} AND p.id<=? AND p.id!=? ORDER BY random() LIMIT 1`).get(...bindings,max,excluded);
      const pivot = pick(avoid) || (avoid ? pick(0) : null);
      if (!pivot) return { ids: [], page: { hasMore: false, nextCursor: null } };
      state = { v:1, viewer, feed, max, pivotRank:Number(pivot.flow_rank), pivotId:Number(pivot.id), lastRank:null, lastId:null, wrapped:false };
    }
    const segment = (wrapped, after, size) => database.prepare(`SELECT p.id,p.flow_rank FROM loop_posts p
      WHERE ${eligible} AND p.id<=? AND (p.flow_rank,p.id) ${wrapped ? '<' : '>='} (?,?)
      ${after ? 'AND (p.flow_rank,p.id) > (?,?)' : ''} ORDER BY p.flow_rank,p.id LIMIT ?`)
      .all(...bindings,state.max,state.pivotRank,state.pivotId,...(after ? [state.lastRank,state.lastId] : []),size)
      .map(row => ({ ...row, wrapped }));
    const rows = segment(state.wrapped, state.lastId !== null, limit+1);
    if (!state.wrapped && rows.length < limit+1) rows.push(...segment(true,false,limit+1-rows.length));
    const page = rows.slice(0,limit), last = page.at(-1), hasMore = rows.length > limit;
    return { ids:page.map(row => Number(row.id)), page:{ hasMore, nextCursor:hasMore ? encode({ ...state, lastRank:Number(last.flow_rank), lastId:Number(last.id), wrapped:last.wrapped }) : null } };
  };
}
