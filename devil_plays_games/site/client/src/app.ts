import * as PIXI from 'pixi.js'
import { GameState } from './state'
import { WS } from './net/ws'
import { Lobby } from './ui/lobby'
import { GameScreen } from './ui/game-screen'
import { PALETTE } from './game/renderer'

export class App {
  private pixi!: PIXI.Application
  readonly state: GameState
  private ws: WS | null = null
  private screen: GameScreen | null = null

  constructor(private container: HTMLElement) {
    this.state = new GameState()
  }

  async start() {
    this.pixi = new PIXI.Application()
    await this.pixi.init({
      resizeTo: this.container,
      backgroundColor: PALETTE.bg,
      antialias: false,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    })
    this.container.appendChild(this.pixi.canvas as HTMLCanvasElement)
    window.addEventListener('resize', () => this.pixi.resize())

    this.showLobby()
  }

  private showLobby() {
    this.pixi.stage.removeChildren()
    const lobby = new Lobby(this.pixi, this.state, (roomID) => this.joinGame(roomID))
    this.pixi.stage.addChild(lobby.container)
  }

  private joinGame(roomID: string) {
    this.pixi.stage.removeChildren()
    this.state.roomID = roomID

    this.ws?.close()
    this.ws = new WS(
      `/api/rooms/${roomID}/ws`,
      this.state.playerID,
      this.state.lastSeq,
      (msg) => {
        this.state.applyServerMsg(msg)
        this.screen?.render()
      },
    )
    this.ws.connect()

    this.screen = new GameScreen(this.pixi, this.state, this.ws)
    this.pixi.stage.addChild(this.screen.container)
  }
}
