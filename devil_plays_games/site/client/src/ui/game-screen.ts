import * as PIXI from 'pixi.js'
import { layoutHand, PALETTE } from '../game/renderer'
import type { GameState } from '../state'
import type { WS } from '../net/ws'

export class GameScreen {
  readonly container: PIXI.Container
  private handLayer: PIXI.Container
  private statusText: PIXI.Text

  constructor(
    private app: PIXI.Application,
    private state: GameState,
    private ws: WS,
  ) {
    this.container = new PIXI.Container()
    this.handLayer = new PIXI.Container()
    this.statusText = new PIXI.Text({
      text: '',
      style: { fontSize: 16, fill: PALETTE.textLight, fontFamily: 'monospace' },
    })
    this.statusText.position.set(12, 12)
    this.container.addChild(this.handLayer, this.statusText)
    this.render()
  }

  render() {
    const { screen } = this.app
    const view = this.state.view

    this.statusText.text = view
      ? `${view.room.phase} · ${view.room.players.length} players · seq ${view.seq}`
      : 'connecting…'

    layoutHand(view?.hand ?? [], this.handLayer, screen.width, screen.height, (card, _i) => {
      // TODO: replace with game-specific action type
      this.ws.action('play_card', { suit: card.suit, rank: card.rank })
    })
  }
}
