package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jvs/dpg/internal/game"
	"github.com/jvs/dpg/internal/hub"
	"nhooyr.io/websocket"
)

func (a *handlers) serveWS(w http.ResponseWriter, r *http.Request) {
	roomID := chi.URLParam(r, "roomID")
	playerID := r.URL.Query().Get("player_id")
	lastSeqStr := r.URL.Query().Get("last_seq")

	if playerID == "" {
		writeErr(w, http.StatusBadRequest, "player_id required")
		return
	}
	room, err := a.store.GetRoom(roomID)
	if err != nil || room == nil {
		writeErr(w, http.StatusNotFound, "room not found")
		return
	}

	lastSeq := -1
	if lastSeqStr != "" {
		lastSeq, _ = strconv.Atoi(lastSeqStr)
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // tighten for production
	})
	if err != nil {
		return
	}
	defer conn.CloseNow()

	hconn := hub.NewConn(roomID, playerID)
	a.hub.Subscribe(hconn)
	defer a.hub.Unsubscribe(hconn)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Send missed events on reconnect, or a full snapshot on first connect.
	if lastSeq >= 0 {
		events, err := a.store.GetEventsSince(roomID, lastSeq)
		if err == nil && len(events) > 0 {
			for _, ev := range events {
				ev := ev
				if err := a.write(ctx, conn, game.ServerMsg{Type: "event", Event: &ev}); err != nil {
					return
				}
			}
		} else {
			a.sendSnapshot(ctx, conn, roomID, playerID)
		}
	} else {
		a.sendSnapshot(ctx, conn, roomID, playerID)
	}

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var msg game.ClientMsg
			if err := json.Unmarshal(data, &msg); err != nil {
				continue
			}
			a.handleClientMsg(ctx, roomID, playerID, msg)
		}
	}()

	for {
		select {
		case data := <-hconn.Send():
			writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := conn.Write(writeCtx, websocket.MessageText, data)
			cancel()
			if err != nil {
				return
			}
		case <-hconn.Done():
			conn.Close(websocket.StatusNormalClosure, "replaced")
			return
		case <-readDone:
			return
		case <-ctx.Done():
			return
		}
	}
}

func (a *handlers) write(ctx context.Context, conn *websocket.Conn, msg game.ServerMsg) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, data)
}

func (a *handlers) sendSnapshot(ctx context.Context, conn *websocket.Conn, roomID, playerID string) {
	room, err := a.store.GetRoom(roomID)
	if err != nil || room == nil {
		return
	}
	seq, _ := a.store.GetRoomSeq(roomID)
	view := &game.View{
		Room: *room,
		Hand: nil, // populated by game logic once implemented
		Seq:  seq,
	}
	_ = a.write(ctx, conn, game.ServerMsg{Type: "snapshot", View: view})
}

func (a *handlers) handleClientMsg(ctx context.Context, roomID, playerID string, msg game.ClientMsg) {
	switch msg.Type {
	case "action":
		if msg.Action == nil {
			return
		}
		msg.Action.PlayerID = playerID
		a.applyAction(roomID, msg.Action)
	}
}

func (a *handlers) applyAction(roomID string, action *game.Action) {
	if action.Idem != "" {
		if _, found, _ := a.store.CheckIdempotency(action.Idem, roomID); found {
			return
		}
	}

	seq, err := a.store.GetRoomSeq(roomID)
	if err != nil {
		return
	}
	seq++

	payload, _ := json.Marshal(action)
	if err := a.store.AppendEvent(roomID, seq, action.Type, payload); err != nil {
		log.Printf("append event %s/%d: %v", roomID, seq, err)
		return
	}
	if action.Idem != "" {
		result, _ := json.Marshal(map[string]int{"seq": seq})
		_ = a.store.SaveIdempotency(action.Idem, roomID, result)
	}

	ev := game.Event{Seq: seq, Type: action.Type, Payload: payload}
	data, _ := json.Marshal(game.ServerMsg{Type: "event", Event: &ev})
	a.hub.Broadcast(roomID, data)
}
