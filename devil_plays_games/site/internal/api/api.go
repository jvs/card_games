package api

import (
	"github.com/go-chi/chi/v5"
	"github.com/jvs/dpg/internal/hub"
	"github.com/jvs/dpg/internal/store"
)

func Mount(r chi.Router, s *store.Store, h *hub.Hub) {
	a := &handlers{store: s, hub: h}
	r.Route("/api", func(r chi.Router) {
		r.Post("/players", a.createPlayer)
		r.Post("/rooms", a.createRoom)
		r.Get("/rooms/{roomID}", a.getRoom)
		r.Post("/rooms/{roomID}/join", a.joinRoom)
		r.Get("/rooms/{roomID}/ws", a.serveWS)
	})
}

type handlers struct {
	store *store.Store
	hub   *hub.Hub
}
