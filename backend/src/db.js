const Database = require('better-sqlite3')

function initDb(db) {
  db.pragma('journal_mode = WAL')

  db.exec(`
    create table if not exists users (
      id integer primary key autoincrement,
      spotify_user_id text not null unique,
      display_name text,
      email text,
      created_at integer not null
    );

    create table if not exists tokens (
      user_id integer primary key,
      refresh_token text not null,
      updated_at integer not null,
      foreign key(user_id) references users(id) on delete cascade
    );

    create table if not exists sessions (
      session_id text primary key,
      user_id integer not null,
      created_at integer not null,
      expires_at integer not null,
      foreign key(user_id) references users(id) on delete cascade
    );

    create table if not exists tracked_track (
      id integer primary key check (id = 1),
      track_id text not null,
      updated_at integer not null
    );

    create table if not exists challenges (
      id integer primary key autoincrement,
      title text not null,
      track_id text not null,
      track_name text not null,
      starts_at_ms integer not null,
      ends_at_ms integer not null,
      created_at_ms integer not null
    );

    create table if not exists ingestion_state (
      user_id integer primary key,
      last_after_ms integer not null default 0,
      updated_at integer not null,
      foreign key(user_id) references users(id) on delete cascade
    );

    create table if not exists plays (
      id integer primary key autoincrement,
      user_id integer not null,
      track_id text not null,
      played_at text not null,
      played_at_ms integer not null,
      foreign key(user_id) references users(id) on delete cascade,
      unique(user_id, track_id, played_at)
    );

    create index if not exists idx_plays_track_time on plays(track_id, played_at_ms);
    create index if not exists idx_plays_user_time on plays(user_id, played_at_ms);

    create table if not exists oauth_states (
      state text primary key,
      return_to text not null,
      expires_at integer not null
    );
    create index if not exists idx_oauth_states_expires on oauth_states(expires_at);

    create table if not exists oauth_handoffs (
      token text primary key,
      session_id text not null,
      expires_at integer not null,
      foreign key(session_id) references sessions(session_id) on delete cascade
    );
    create index if not exists idx_oauth_handoffs_expires on oauth_handoffs(expires_at);
  `)
}

/**
 * Legacy DBs: plays without challenge_id → recreate with challenge_id + FK.
 * Call after bootstrapChallengeFromEnvIfEmpty so at least one challenge row exists.
 */
function migratePlaysIfNeeded(db) {
  const cols = db.prepare('pragma table_info(plays)').all()
  if (cols.length === 0) return
  if (cols.some((c) => c.name === 'challenge_id')) return

  const row = db.prepare('select id from challenges order by id limit 1').get()
  if (!row) return

  const challengeId = row.id

  const migrate = db.transaction(() => {
    db.exec(`
      create table plays_new (
        id integer primary key autoincrement,
        user_id integer not null,
        challenge_id integer not null,
        track_id text not null,
        played_at text not null,
        played_at_ms integer not null,
        foreign key(user_id) references users(id) on delete cascade,
        foreign key(challenge_id) references challenges(id) on delete cascade,
        unique(user_id, challenge_id, played_at)
      );
    `)
    db.prepare(
      `
      insert into plays_new (user_id, challenge_id, track_id, played_at, played_at_ms)
      select user_id, ?, track_id, played_at, played_at_ms from plays
    `,
    ).run(challengeId)
    db.exec('drop table plays')
    db.exec('alter table plays_new rename to plays')
    db.exec(`
      create index if not exists idx_plays_track_time on plays(track_id, played_at_ms);
      create index if not exists idx_plays_user_time on plays(user_id, played_at_ms);
      create index if not exists idx_plays_challenge on plays(challenge_id, played_at_ms);
    `)
  })
  migrate()
}

/** Legacy DBs created before `users.email` existed. */
function migrateUsersEmailIfNeeded(db) {
  const cols = db.prepare('pragma table_info(users)').all()
  if (cols.some((c) => c.name === 'email')) return
  db.exec('alter table users add column email text')
}

function openDb(dbPath) {
  const db = new Database(dbPath)
  initDb(db)
  migrateUsersEmailIfNeeded(db)
  return db
}

module.exports = { openDb, migratePlaysIfNeeded }
