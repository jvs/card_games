package hub

import "sync"

// Conn is an active WebSocket connection for one player in one room.
type Conn struct {
	PlayerID string
	RoomID   string
	send     chan []byte
	done     chan struct{}
}

func NewConn(roomID, playerID string) *Conn {
	return &Conn{
		PlayerID: playerID,
		RoomID:   roomID,
		send:     make(chan []byte, 32),
		done:     make(chan struct{}),
	}
}

func (c *Conn) Send() <-chan []byte   { return c.send }
func (c *Conn) Done() <-chan struct{} { return c.done }

type Hub struct {
	mu    sync.RWMutex
	rooms map[string]map[string]*Conn // roomID → playerID → conn

	subscribe   chan *Conn
	unsubscribe chan *Conn
	broadcast   chan roomMsg
	direct      chan directMsg
}

type roomMsg struct {
	roomID string
	data   []byte
}

type directMsg struct {
	roomID   string
	playerID string
	data     []byte
}

func New() *Hub {
	return &Hub{
		rooms:       make(map[string]map[string]*Conn),
		subscribe:   make(chan *Conn, 16),
		unsubscribe: make(chan *Conn, 16),
		broadcast:   make(chan roomMsg, 256),
		direct:      make(chan directMsg, 256),
	}
}

func (h *Hub) Run() {
	for {
		select {
		case c := <-h.subscribe:
			h.mu.Lock()
			if h.rooms[c.RoomID] == nil {
				h.rooms[c.RoomID] = make(map[string]*Conn)
			}
			if old, ok := h.rooms[c.RoomID][c.PlayerID]; ok {
				close(old.done) // kick the previous connection for this player
			}
			h.rooms[c.RoomID][c.PlayerID] = c
			h.mu.Unlock()

		case c := <-h.unsubscribe:
			h.mu.Lock()
			if room := h.rooms[c.RoomID]; room != nil {
				if room[c.PlayerID] == c {
					delete(room, c.PlayerID)
				}
				if len(room) == 0 {
					delete(h.rooms, c.RoomID)
				}
			}
			h.mu.Unlock()

		case msg := <-h.broadcast:
			h.mu.RLock()
			for _, c := range h.rooms[msg.roomID] {
				select {
				case c.send <- msg.data:
				default: // slow client; drop and let them resync on reconnect
				}
			}
			h.mu.RUnlock()

		case msg := <-h.direct:
			h.mu.RLock()
			if room := h.rooms[msg.roomID]; room != nil {
				if c := room[msg.playerID]; c != nil {
					select {
					case c.send <- msg.data:
					default:
					}
				}
			}
			h.mu.RUnlock()
		}
	}
}

func (h *Hub) Subscribe(c *Conn)   { h.subscribe <- c }
func (h *Hub) Unsubscribe(c *Conn) { h.unsubscribe <- c }

func (h *Hub) Broadcast(roomID string, data []byte) {
	h.broadcast <- roomMsg{roomID: roomID, data: data}
}

func (h *Hub) Direct(roomID, playerID string, data []byte) {
	h.direct <- directMsg{roomID: roomID, playerID: playerID, data: data}
}
