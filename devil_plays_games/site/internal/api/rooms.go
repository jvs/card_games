package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jvs/dpg/internal/game"
	"github.com/jvs/dpg/internal/uid"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (a *handlers) createPlayer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	id := uid.New()
	if err := a.store.CreatePlayer(id, body.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "create player failed")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": id})
}

func (a *handlers) createRoom(w http.ResponseWriter, r *http.Request) {
	var body struct {
		GameType string `json:"game_type"`
		PlayerID string `json:"player_id"`
		Name     string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.GameType == "" {
		body.GameType = "default"
	}

	roomID := uid.New()
	if err := a.store.CreateRoom(roomID, body.GameType); err != nil {
		writeErr(w, http.StatusInternalServerError, "create room failed")
		return
	}
	if body.PlayerID != "" {
		_ = a.store.CreatePlayer(body.PlayerID, body.Name)
		_ = a.store.JoinRoom(roomID, body.PlayerID, 0)
	}

	writeJSON(w, http.StatusCreated, map[string]string{"room_id": roomID})
}

func (a *handlers) getRoom(w http.ResponseWriter, r *http.Request) {
	roomID := chi.URLParam(r, "roomID")
	room, err := a.store.GetRoom(roomID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "get room failed")
		return
	}
	if room == nil {
		writeErr(w, http.StatusNotFound, "room not found")
		return
	}
	writeJSON(w, http.StatusOK, room)
}

func (a *handlers) joinRoom(w http.ResponseWriter, r *http.Request) {
	roomID := chi.URLParam(r, "roomID")
	var body struct {
		PlayerID string `json:"player_id"`
		Name     string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.PlayerID == "" {
		writeErr(w, http.StatusBadRequest, "player_id required")
		return
	}

	room, err := a.store.GetRoom(roomID)
	if err != nil || room == nil {
		writeErr(w, http.StatusNotFound, "room not found")
		return
	}

	_ = a.store.CreatePlayer(body.PlayerID, body.Name)
	seat := len(room.Players)
	if err := a.store.JoinRoom(roomID, body.PlayerID, seat); err != nil {
		writeErr(w, http.StatusInternalServerError, "join failed")
		return
	}

	a.broadcastEvent(roomID, "player_joined", map[string]any{
		"player_id": body.PlayerID,
		"name":      body.Name,
		"seat":      seat,
	})

	writeJSON(w, http.StatusOK, map[string]any{"seat": seat})
}

func (a *handlers) broadcastEvent(roomID, eventType string, payload any) {
	p, err := json.Marshal(payload)
	if err != nil {
		return
	}
	seq, err := a.store.GetRoomSeq(roomID)
	if err != nil {
		return
	}
	seq++
	if err := a.store.AppendEvent(roomID, seq, eventType, p); err != nil {
		return
	}
	ev := game.Event{Seq: seq, Type: eventType, Payload: p}
	data, _ := json.Marshal(game.ServerMsg{Type: "event", Event: &ev})
	a.hub.Broadcast(roomID, data)
}
