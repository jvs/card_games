package game

import (
	"encoding/json"
	"time"
)

type Card struct {
	Suit string `json:"suit"`
	Rank string `json:"rank"`
}

type Phase string

const (
	PhaseWaiting Phase = "waiting"
	PhaseBidding Phase = "bidding"
	PhasePlaying Phase = "playing"
	PhaseScoring Phase = "scoring"
)

type Player struct {
	ID   string `json:"id"`
	Seat int    `json:"seat"`
	Name string `json:"name"`
}

type Room struct {
	ID        string    `json:"id"`
	GameType  string    `json:"game_type"`
	Phase     Phase     `json:"phase"`
	Players   []Player  `json:"players"`
	CreatedAt time.Time `json:"created_at"`
}

// State is the full server-side game state.
type State struct {
	Room  Room
	Hands map[string][]Card
	Seq   int
}

// View is the player-visible subset of State sent over the wire.
type View struct {
	Room Room   `json:"room"`
	Hand []Card `json:"hand"`
	Seq  int    `json:"seq"`
}

type Action struct {
	Type     string          `json:"type"`
	PlayerID string          `json:"player_id"`
	Payload  json.RawMessage `json:"payload"`
	Idem     string          `json:"idem"` // idempotency key
}

type Event struct {
	Seq     int             `json:"seq"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// ServerMsg is sent from server to client over WebSocket.
type ServerMsg struct {
	Type string `json:"type"`
	// type == "event"
	Event *Event `json:"event,omitempty"`
	// type == "snapshot"
	View *View `json:"view,omitempty"`
	// type == "ack"
	Idem string `json:"idem,omitempty"`
	// type == "error"
	Error string `json:"error,omitempty"`
}

// ClientMsg is sent from client to server over WebSocket.
type ClientMsg struct {
	Type    string  `json:"type"`
	Action  *Action `json:"action,omitempty"`
	LastSeq *int    `json:"last_seq,omitempty"`
}
