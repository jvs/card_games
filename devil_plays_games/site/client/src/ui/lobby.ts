import * as PIXI from 'pixi.js'
import { makeButton, PALETTE } from '../game/renderer'
import type { GameState } from '../state'

export class Lobby {
  readonly container: PIXI.Container

  constructor(
    private app: PIXI.Application,
    private state: GameState,
    private onJoin: (roomID: string) => void,
  ) {
    this.container = new PIXI.Container()
    this.build()
  }

  private build() {
    const { screen } = this.app

    const title = new PIXI.Text({
      text: 'Devil Plays Games',
      style: { fontSize: 28, fill: PALETTE.textLight, fontFamily: 'monospace', fontWeight: 'bold' },
    })
    title.anchor.set(0.5, 0)
    title.position.set(screen.width / 2, 56)
    this.container.addChild(title)

    // If URL hash contains a room ID, go straight to joining.
    const roomID = location.hash.slice(1)
    if (roomID) {
      this.joinRoom(roomID)
      return
    }

    const btn = makeButton('New Game')
    btn.position.set(screen.width / 2 - 110, screen.height / 2 - 32)
    btn.on('pointerdown', () => this.createRoom())
    this.container.addChild(btn)
  }

  private async createRoom() {
    const playerID = await this.ensurePlayer()
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_id: playerID,
        name: this.state.playerName,
        game_type: 'default',
      }),
    })
    const { room_id } = (await res.json()) as { room_id: string }
    location.hash = room_id
    this.onJoin(room_id)
  }

  private async joinRoom(roomID: string) {
    const playerID = await this.ensurePlayer()
    await fetch(`/api/rooms/${roomID}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: playerID, name: this.state.playerName }),
    })
    this.onJoin(roomID)
  }

  private async ensurePlayer(): Promise<string> {
    if (this.state.playerID) return this.state.playerID
    const res = await fetch('/api/players', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Player' }),
    })
    const { id } = (await res.json()) as { id: string }
    this.state.setPlayer(id, 'Player')
    return id
  }
}
