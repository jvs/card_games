package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jvs/dpg/internal/game"
	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_journal_mode=WAL&_foreign_keys=on&_busy_timeout=5000")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // SQLite WAL: one writer at a time
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	_, err := s.db.Exec(schema)
	return err
}

const schema = `
CREATE TABLE IF NOT EXISTS players (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    created_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rooms (
    id          TEXT PRIMARY KEY,
    game_type   TEXT NOT NULL,
    phase       TEXT NOT NULL DEFAULT 'waiting',
    state_json  TEXT NOT NULL DEFAULT '{}',
    seq         INTEGER NOT NULL DEFAULT 0,
    created_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS room_players (
    room_id     TEXT NOT NULL REFERENCES rooms(id),
    player_id   TEXT NOT NULL REFERENCES players(id),
    seat        INTEGER NOT NULL,
    joined_at   DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room_id, player_id)
);

CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id      TEXT NOT NULL REFERENCES rooms(id),
    seq          INTEGER NOT NULL,
    type         TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at   DATETIME NOT NULL DEFAULT (datetime('now')),
    UNIQUE (room_id, seq)
);

CREATE TABLE IF NOT EXISTS applied_actions (
    idem         TEXT NOT NULL,
    room_id      TEXT NOT NULL,
    result_json  TEXT NOT NULL DEFAULT '{}',
    created_at   DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (idem, room_id)
);
`

func (s *Store) CreatePlayer(id, name string) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO players (id, name) VALUES (?, ?)`, id, name)
	return err
}

func (s *Store) GetPlayer(id string) (*game.Player, error) {
	var p game.Player
	err := s.db.QueryRow(`SELECT id, name FROM players WHERE id = ?`, id).Scan(&p.ID, &p.Name)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return &p, err
}

func (s *Store) CreateRoom(id, gameType string) error {
	_, err := s.db.Exec(`INSERT INTO rooms (id, game_type) VALUES (?, ?)`, id, gameType)
	return err
}

func (s *Store) GetRoom(id string) (*game.Room, error) {
	var r game.Room
	var createdAt string
	err := s.db.QueryRow(
		`SELECT id, game_type, phase, created_at FROM rooms WHERE id = ?`, id,
	).Scan(&r.ID, &r.GameType, &r.Phase, &createdAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)

	players, err := s.GetRoomPlayers(id)
	if err != nil {
		return nil, err
	}
	r.Players = players
	return &r, nil
}

func (s *Store) GetRoomPlayers(roomID string) ([]game.Player, error) {
	rows, err := s.db.Query(
		`SELECT p.id, p.name, rp.seat
		 FROM room_players rp JOIN players p ON p.id = rp.player_id
		 WHERE rp.room_id = ?
		 ORDER BY rp.seat`,
		roomID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var players []game.Player
	for rows.Next() {
		var p game.Player
		if err := rows.Scan(&p.ID, &p.Name, &p.Seat); err != nil {
			return nil, err
		}
		players = append(players, p)
	}
	return players, rows.Err()
}

func (s *Store) JoinRoom(roomID, playerID string, seat int) error {
	_, err := s.db.Exec(
		`INSERT OR IGNORE INTO room_players (room_id, player_id, seat) VALUES (?, ?, ?)`,
		roomID, playerID, seat,
	)
	return err
}

func (s *Store) GetRoomSeq(roomID string) (int, error) {
	var seq int
	err := s.db.QueryRow(`SELECT seq FROM rooms WHERE id = ?`, roomID).Scan(&seq)
	return seq, err
}

func (s *Store) AppendEvent(roomID string, seq int, eventType string, payload json.RawMessage) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(
		`INSERT INTO events (room_id, seq, type, payload_json) VALUES (?, ?, ?, ?)`,
		roomID, seq, eventType, string(payload),
	)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`UPDATE rooms SET seq = ? WHERE id = ?`, seq, roomID)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) GetEventsSince(roomID string, afterSeq int) ([]game.Event, error) {
	rows, err := s.db.Query(
		`SELECT seq, type, payload_json FROM events
		 WHERE room_id = ? AND seq > ?
		 ORDER BY seq`,
		roomID, afterSeq,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []game.Event
	for rows.Next() {
		var e game.Event
		var payload string
		if err := rows.Scan(&e.Seq, &e.Type, &payload); err != nil {
			return nil, err
		}
		e.Payload = json.RawMessage(payload)
		events = append(events, e)
	}
	return events, rows.Err()
}

func (s *Store) CheckIdempotency(idem, roomID string) (json.RawMessage, bool, error) {
	var result string
	err := s.db.QueryRow(
		`SELECT result_json FROM applied_actions WHERE idem = ? AND room_id = ?`, idem, roomID,
	).Scan(&result)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return json.RawMessage(result), true, nil
}

func (s *Store) SaveIdempotency(idem, roomID string, result json.RawMessage) error {
	_, err := s.db.Exec(
		`INSERT OR IGNORE INTO applied_actions (idem, room_id, result_json) VALUES (?, ?, ?)`,
		idem, roomID, string(result),
	)
	return err
}
