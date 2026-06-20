import * as PIXI from 'pixi.js'
import type { Card } from '../state'

const CARD_W = 80
const CARD_H = 112
const CARD_RADIUS = 8

// Design palette — bright, limited, GBA-inspired
export const PALETTE = {
  bg:       0x1a1a2e,
  surface:  0x16213e,
  accent:   0xe94560,
  card:     0xf5f0e8,
  cardBack: 0x0f3460,
  text:     0x1a1a2e,
  textLight:0xf5f0e8,
}

export function makeCard(card: Card | null): PIXI.Container {
  const c = new PIXI.Container()

  const bg = new PIXI.Graphics()
  bg.roundRect(0, 0, CARD_W, CARD_H, CARD_RADIUS)
  bg.fill(card ? PALETTE.card : PALETTE.cardBack)
  bg.stroke({ width: 2, color: 0x00000033 })
  c.addChild(bg)

  if (card) {
    const label = new PIXI.Text({
      text: `${card.rank}\n${card.suit}`,
      style: {
        fontSize: 20,
        fill: PALETTE.text,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        align: 'center',
      },
    })
    label.anchor.set(0.5, 0.5)
    label.position.set(CARD_W / 2, CARD_H / 2)
    c.addChild(label)
  }

  return c
}

export function layoutHand(
  hand: Card[],
  target: PIXI.Container,
  screenW: number,
  screenH: number,
  onPlay?: (card: Card, index: number) => void,
) {
  target.removeChildren()
  if (hand.length === 0) return

  const maxSpacing = CARD_W + 8
  const available = screenW - 32
  const spacing = Math.min(maxSpacing, available / hand.length)
  const totalW = spacing * (hand.length - 1) + CARD_W
  const startX = (screenW - totalW) / 2
  const y = screenH - CARD_H - 24

  for (let i = 0; i < hand.length; i++) {
    const sprite = makeCard(hand[i])
    sprite.position.set(startX + i * spacing, y)

    if (onPlay) {
      sprite.interactive = true
      sprite.cursor = 'pointer'
      sprite.on('pointerdown', () => onPlay(hand[i], i))
      sprite.on('pointerover', () => { sprite.y = y - 12 })
      sprite.on('pointerout', () => { sprite.y = y })
    }

    target.addChild(sprite)
  }
}

export function makeButton(label: string, w = 220, h = 64): PIXI.Container {
  const c = new PIXI.Container()
  c.interactive = true
  c.cursor = 'pointer'

  const bg = new PIXI.Graphics()
  bg.roundRect(0, 0, w, h, 10)
  bg.fill(PALETTE.accent)
  c.addChild(bg)

  const text = new PIXI.Text({
    text: label,
    style: { fontSize: 24, fill: PALETTE.textLight, fontFamily: 'monospace', fontWeight: 'bold' },
  })
  text.anchor.set(0.5, 0.5)
  text.position.set(w / 2, h / 2)
  c.addChild(text)

  c.on('pointerover', () => bg.tint = 0xdddddd)
  c.on('pointerout', () => bg.tint = 0xffffff)

  return c
}
