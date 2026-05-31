# Panther

A trick-taking card game for 3 players.

(Work in progress.)

---

## Overview

Three players compete across multiple hands. Each hand, one player becomes **the Panther** through an auction, taking control of a face-up **Crow hand** and playing two hands against the other two players (**the Hunters**). The first player to **50 points** wins.

---

## Components

### The Deck (45 cards)

**Traditional Suits (40 cards)** — Four suits of 10 cards each:

| Suit | Prank Card | Number Cards | Face Cards |
|------|-----------|--------------|------------|
| Spades | Snitch | 5, 6, 7, 8, 9, 10 | Jack, Queen, King, Ace |
| Diamonds | Devil | 5, 6, 7, 8, 9, 10 | Jack, Queen, King, Ace |
| Hearts | Hound | 5, 6, 7, 8, 9, 10 | Jack, Queen, King, Ace |
| Clubs | Cat | 5, 6, 7, 8, 9, 10 | Jack, Queen, King, Ace |

Rank order within a suit (low to high): Prank, 5, 6, 7, 8, 9, 10, Jack, Queen, King, Ace.

**Perils (5 cards)** — The greater trump suit. Perils always beat any card from a traditional suit, including lesser trump.

| Card | Rank |
|------|------|
| Goblin | 21 |
| Ogre | 22 |
| Dragon | 23 |
| Witch | 24 |
| Death | 25 |

Rank order (low to high): Goblin, Ogre, Dragon, Witch, Death.

**Stories (4 cards)**

- Fight
- Run
- Hide
- Panic


---

## Setup

1. Shuffle the deck.
2. Deal **10 cards** to each player.
3. Deal **10 cards face-up** to the center of the table. This is the **Crow hand** (or just "the Crow").
4. Deal **5 cards face-down** to the side. These cards form **the Woods** — out of play and not revealed until the hand is over.
5. The dealer sorts the Crow by suit and rank, so all players can read it easily.

All players may examine the Crow before bidding begins.

---

## The Auction

The player to the dealer's left bids first. Each player may bid or pass.

A bid consists of a **Story** and a **trump declaration** - either a lesser trump suit or "Perils Only". For example: "Fight with Hearts" or "Hide with Perils Only".


**Fight**
- Goal: Crow and Panther take tricks.
- If Crow and Panther take 7 tricks: +2 points
- If Crow and Panther take 8 tricks: +3 points
- If Crow and Panther take 9 or 10 tricks: +4 points
- Otherwise: +1 point to each Hunter (or +2 with raised stakes)

**Run**
- Goal: Crow and Panther avoid tricks.
- If Crow and Panther take 3 tricks: +2 point
- If Crow and Panther take 2 tricks: +3 points
- If Crow and Panther take 1 or 0 tricks: +4 points
- Otherwise: +2 points to each Hunter (or +4 with raised stakes)

**Hide**
- Goal: Panther avoids tricks.
- If Panther takes 0 tricks: +4 points
- Otherwise: +1 points to each Hunter (or +2 with raised stakes)

**Panic**
- Special: This story is only used when each player passes.
- Goal: win 4, 5, or 6 tricks.
- If Crow and Panther take 4 or 6 tricks: +3 point
- If Crow and Panther take 5 tricks: +4 points
- Otherwise: +1 point to each Hunter


**After each player has bid:**
- If no one bid: The player to the left of the dealer must bid using the Panic story. The may select any suit as trump or declare Perils only. This is the only time when a player may bid using Panic.
- If one player bid: That player wins the auction.
- If multple players bid: Each player who bid may **raise the stakes** of their own bid.

**Raising the stakes**:
When a player raises the stakes, they double the failure penalty of their bid. Other players who don't raise the stakes of their own bids are then forced to retract their bids.

**Tie breaking**:
- If the auction has two bids: The other player (the player who passed or retracted) selects the winning bid.
- If the auction has three bids: The player to the left of the dealer selects the winning bid. They may select their own, but they don't have to.

The player with the winning bid becomes the Panther. Place the appropriate Story card in front of the Panther player. Place the Crow across from the Panther, and the Panther leads the first trick.

---

## Trump Hierarchy

Cards from strongest to weakest:

1. **Perils** (greater trump) — Death > Witch > Dragon > Ogre > Goblin
2. **Lesser trump** (the suit named in the winning bid) — normal rank order within the suit
3. **Led suit** — the suit of the first card played in a trick
4. **Off-suit cards** — cannot win a trick

Perils are always the greater trump. Lesser trump beats non-trump suits. If no Peril or trump is played, the highest card of the led suit wins.

If "Perils Only" was declared, there is no lesser trump — only Perils outrank the led suit.

---

## Playing a Hand

The Panther controls two hands: their own hand (hidden, like any player's) and the Crow (face-up, visible to all). These are separate hands — each follows suit independently, and each plays in its own seat in the turn order.

The Panther leads the first trick. After that, the winner of each trick leads the next. If the Crow wins a trick, the Crow leads the next trick (with the Panther choosing which card to play from it). Play proceeds clockwise. On the Crow's turn, the Panther plays a card from the Crow.

### Following Suit

- Players must follow the led suit if able.
- If a player cannot follow suit, they may play any card.
- The Panther's own hand and the Crow follow suit **independently**. Each must follow the led suit using only the cards available in that hand.

### Leading Perils

- **Leading with a Peril:** Other players must play a Peril if able. If they have no Perils, they may play any card. *(Perils are their own suit.)*


---

## Prank Cards

Each suit's Prank card has a unique ability. Prank abilities take effect **immediately when played** (before the trick resolves), except where noted.

Prank cards are the **lowest-ranked card** in their suit — playing one means you're almost certainly losing the trick. The ability is the trade-off.

### The Cat (Clubs)
Choose who leads the next trick: yourself, another player, or the Crow. The chosen player leads regardless of who wins this trick. *(Takes effect after the trick resolves.)*

### The Devil (Diamonds)
Choose a target: another player or the Crow. You and the target each exchange a card face-down. If the target is the Crow, the Panther chooses which Crow card to exchange, and both cards are revealed (since the Crow is face-up).

### The Hound (Hearts)
Look at all cards in the Woods.

### The Snitch (Spades)
Ask one player a single yes-or-no question about the cards currently in their hand. They must answer immediately and truthfully, and all players hear the answer.

---

## Scoring

After all 10 tricks have been played, check the Panther's Story card and award points. 
- Award double points to the Panther if the player was forced to bid.
- Award double points to the Hunters if the Panther raised the stakes.

---

## Winning the Game

The first player to reach **25 points** wins.

If multiple players cross 25 on the same hand, the player with the higher score wins. If still tied, then it's a tie. You've met your match!

---

## Turn Summary

1. **Deal** — 10 to each player, 10 face-up to the Crow, 5 face-down to the Woods.
2. **Auction** — Each player may bid a story and a trump declaration. Players select the winning bid.
3. **Setup** — Crow placed across from the Panther.
4. **Play** — 10 tricks, normal clockwise play. Panther leads first.
5. **Score** — Award points based on the Panther's Story and result.
6. **Rotate** — Dealer passes clockwise. Shuffle and deal a new hand.
