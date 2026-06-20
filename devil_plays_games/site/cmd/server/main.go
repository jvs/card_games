package main

import (
	"log"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jvs/dpg/internal/api"
	"github.com/jvs/dpg/internal/hub"
	"github.com/jvs/dpg/internal/store"
	"github.com/jvs/dpg/web"
)

func main() {
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "dpg.db"
	}
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = ":8080"
	}

	db, err := store.Open(dbPath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer db.Close()

	h := hub.New()
	go h.Run()

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	api.Mount(r, db, h)
	r.Handle("/*", http.FileServer(http.FS(web.FS)))

	log.Printf("listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, r))
}
