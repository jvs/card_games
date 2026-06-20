export interface Card {
  suit: string
  rank: string
}

export interface Player {
  id: string
  seat: number
  name: string
}

export interface Room {
  id: string
  game_type: string
  phase: string
  players: Player[]
  created_at: string
}

export interface GameView {
  room: Room
  hand: Card[]
  seq: number
}

export interface GameEvent {
  seq: number
  type: string
  payload: unknown
}

export type ServerMsg =
  | { type: 'event'; event: GameEvent }
  | { type: 'snapshot'; view: GameView }
  | { type: 'ack'; idem: string }
  | { type: 'error'; error: string }

export class GameState {
  playerID: string
  playerName: string
  roomID: string | null = null
  view: GameView | null = null
  lastSeq = -1
  onChange: (() => void) | null = null

  constructor() {
    this.playerID = localStorage.getItem('player_id') ?? ''
    this.playerName = localStorage.getItem('player_name') ?? 'Player'
  }

  setPlayer(id: string, name: string) {
    this.playerID = id
    this.playerName = name
    localStorage.setItem('player_id', id)
    localStorage.setItem('player_name', name)
  }

  applyServerMsg(msg: ServerMsg) {
    switch (msg.type) {
      case 'snapshot':
        this.view = msg.view
        this.lastSeq = msg.view.seq
        break
      case 'event':
        this.lastSeq = msg.event.seq
        this.applyEvent(msg.event)
        break
    }
    this.onChange?.()
  }

  private applyEvent(ev: GameEvent) {
    if (!this.view) return
    switch (ev.type) {
      case 'player_joined': {
        const p = ev.payload as Player
        if (!this.view.room.players.find(x => x.id === p.id)) {
          this.view.room.players.push(p)
        }
        break
      }
    }
  }
}
