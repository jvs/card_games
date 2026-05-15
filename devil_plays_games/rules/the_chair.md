# The Chair

A six-player trick-taking game of corporate politics.

(Work in progress)

---

## Premise

Six players. One holds **the Chair**; the other five are **Executives**. The Chair has a public goal; each Executive has a hidden **Agenda**. Across multiple **Quarters**, players jockey for points and for the Chair itself. The winner of each Quarter takes the Chair next.

The game lives in its hidden-agenda layer and its proposal mechanic. Trick-taking is the substrate; corporate politics is the game.

---

## Components

### Playing Deck (61 cards)

**Four standard suits** — Spades, Hearts, Diamonds, Clubs — 13 cards each (52 total):

2, 3, 4, 5, 6, 7, 8, 9, 10, Jack, Queen, King, Ace.

Standard rank order. Ace high. (The 2 of each suit is replaced by that suit's Prank card — see below.)

**Shares** (the trump suit) — 9 cards:

Penny Share, 2 Shares, 3 Shares, 4 Shares, 5 Shares, 6 Shares, 7 Shares, 8 Shares, Golden Share.

Penny Share is the lowest. Golden Share is the highest. Any Share beats any non-Share card regardless of rank.

**Prank cards** — 4 cards, one per traditional suit, replacing the 2 in that suit:

- **The Cat** (Clubs)
- **The Devil** (Diamonds)
- **The Hound** (Hearts)
- **The Snitch** (Spades)

Pranks are the lowest card in their suit. See *Prank Card Effects* below.

### Agenda Deck

~15 Agenda cards. Each Executive draws one secret Agenda per Quarter. See *Agendas* below.

### Chair Initiative Deck

~6-8 Chair Goal cards. The current Chair draws one public goal per Quarter. See *Chair Initiatives* below.

---

## The Fiscal Period

A Fiscal Period is a fixed number of Quarters. Most points at the end wins.

### Setup

1. Players agree on the Fiscal Period length (default: 5 Quarters).
2. Choose the first Chair arbitrarily (random draw, oldest player, etc.).
3. Begin Quarter 1.

### Each Quarter

1. **Chair Initiative:** The Chair draws one Chair Initiative card and places it face-up on the table. This is their victory condition for the Quarter.
2. **Executive Agendas:** Each Executive draws one Agenda card and keeps it face-down.
3. **Deal:** Shuffle the playing deck. Deal 10 cards to each player. Burn the last card face-down.
4. **Play 10 tricks** using the proposal mechanic.
5. **Score:** At the end of the Quarter, all Agendas are revealed. Score points for any Agenda whose conditions were met. Score the Chair Initiative if achieved.
6. **Chair rotation:** The player with the most share cards in their won tricks becomes the new Chair for the next Quarter. If there is a tie, or if the current Chair has the most share cards, the current Chair retains their position.

### Winner of the Game

After the final Quarter, the player with the most cumulative points wins.

In case of a tie, it's a tie. Congratulations to the winners!

---

## The Proposal Mechanic

Each trick starts with proposals from all the executives.

### Each Trick

1. **Proposal Phase:**
   - Each Executive selects one card from their hand and places it face-down in front of themselves.
   - Once all proposals are placed, they are flipped face-up simultaneously.
2. **Approval Phase:**
   - The Chair reviews the proposals and approves one. The selected card becomes the **lead card** for this trick.
   - (Special case: a Hostile Takeover player may reveal their Agenda at this moment to override the Chair's selection. See *Hostile Takeover* below.)
3. **Deliverable Phase:**
   - Rejected Executives return their proposed cards to their hand.
   - Each Executive then plays one card face-down as a deliverable.
   - All deliverables are flipped face-up simultaneously.
4. **Chair Plays:**
   - The Chair plays one card face-up after all Executive deliverables are revealed. The Chair has full information when they play.
5. **Special Card Resolution:**
   - Any Prank cards or wild cards in the trick resolve their effects now (see *Prank Card Effects*).
6. **Trick Resolution:**
   - Highest Share wins. Otherwise, highest card of the lead suit wins. Off-suit non-Share cards cannot win.
   - The winner collects the cards into their trick pile.

### Proposal Rules

- Executives may propose any card from their hand.
- An Executive whose proposal is selected does *not* play a deliverable that trick — their proposal *is* their card for that trick.
- Rejected Executives return their proposal to hand and play a deliverable normally.
- All other players (including The Chair) must follow suit if they can. Otherwise, they may play any card as their deliverable.

### Lead Information Advantage

The winner of a trick gains an information advantage on the next trick:

- For trick 1, all Executives propose simultaneously.
- For trick 2+, the four non-winning Executives propose simultaneously. The winner of the previous trick (if an Executive) sees those four proposals before making their own.
- If the Chair won the previous trick, all five Executives propose simultaneously.

This rewards trick-winning without giving the winner the lead — they get to *pitch better*, not pick the lead.

---

## Prank Card Effects

Prank effects resolve after the Chair plays but before the trick is resolved. If multiple Pranks are played in the same trick, they resolve in alphabetical order: Cat, Devil, Hound, Snitch.

### The Cat (Clubs Prank)

The Cat-player names any one Executive. That Executive's proposal next trick is automatically approved by the Chair (no Chair selection occurs). Effectively, the Cat-player steals one approval from the Chair and hands it to the named player (who may be the Cat-player themselves).

### The Devil (Diamonds Prank)

The Devil-player names two other players (one may be themselves). Those two players must exchange one card face-down from their hands. Only those two players know the identity of the exchanged cards.

### The Hound (Hearts Prank)

When revealed, the Hound-player chooses one of:
- Look at one named player's full hand.
- Look at one named player's Agenda card (face-down) and return it.

### The Snitch (Spades Prank)

When revealed, the Snitch-player names another Executive. That Executive must flip their Agenda card face-up for the rest of the Quarter. Their Agenda is now public knowledge.

---

## Chair Initiatives

The Chair draws one Chair Initiative card per Quarter. The goal is public — all Executives can see what the Chair is playing for. Achieving the initiative scores 2 points for the Chair.

### Example Chair Initiatives

**Maximize Shareholder Value:** The Chair wins the most tricks (more than any individual Executive).

**Reduce Headcount:** At least one Executive wins zero tricks.

**Training and Development:** Every Executive wins at least one trick.

**Cut Costs:** No Executive wins more than 2 tricks.

**Performance Bonus:** The Chair wins the trick containing the Golden Share.

---

## Agendas

Each Executive draws one Agenda per Quarter. Agendas are hidden until the end of the Quarter (with the exception of Hostile Takeover's reveal mechanic — see below).

Each Agenda has a printed point value: 1, 2, or 3 points.

### Agenda Deck Structure

### Trick-Count Agendas

**Climb the Ladder** *(2 points)*
Win the most tricks of any Executive. (Ties don't count.)

**Severance Package** *(2 points)*
Win zero tricks.

**Hard Stop at 2** *(1 point)*
Win exactly 2 tricks.

**Corporate Infighting** *(2 points)*
At least one other Executive wins zero tricks.

### Trick-Content Agendas

**Vanity Project** *(1 point)*
Win at least one Ace.

**Stockpile** *(2 points)*
Win at least 3 Share cards.

**Cover All Your Bases** *(2 points)*
Win at least one trick in each of the four standard suits.

**Inside Scoop** *(1 point)*
Win at least one trick containing a Prank card.

### Proposal-Layer Agendas

**On The Boss's Radar** *(2 points)*
Have the most accepted proposals among Executives. (Ties don't count.)

**Keep Your Head Down** *(1 point)*
Have the fewest accepted proposals among Executives. (Ties don't count.)

**Boil The Ocean** *(2 points)*
Have at least 4 proposals rejected by the Chair.

### Coalition Agenda

**Hostile Takeover** *(2 points each)* — appears twice in the Agenda deck.

At the end of the Quarter, combine your won Share cards with any other player holding Hostile Takeover. If together you hold **5 or more Share cards**, each Hostile Takeover player scores 2 points.

**Reveal mechanic:** During any trick's proposal phase, after proposals are revealed face-up but *before* the Chair selects, you may reveal your Agenda card. If you do, your proposal is automatically approved for that trick, skipping the Chair's Approval Phase.

Once revealed, your Agenda is public for the rest of the Quarter.

The reveal is one-time-use per player. Use it to identify yourself to your hidden partner, or to grab a critical approval at a key moment.

**Chair rotation:** If Hostile Takeover succeeds, the next Chair is the Hostile Takeover player with the most Share cards in their won tricks. If there is a tie, the current Chair retains their position.

### Identification Agenda

**Firm-Wide Audit** *(3 points)*
At any point during the Quarter, you may name another Executive with a face-down Agenda and accuse them of holding Hostile Takeover. If correct, you score 3 points. If wrong, you lose 1 point.

You may make at most one accusation per Quarter.


### Anti-Chair Agenda

**Corporate Sabotage** *(3 points)*
The Chair fails their public goal.

---

## Communication

Players may talk freely during the game. Table talk is encouraged. Lying about your Agenda is allowed.

However, **you may not show your Agenda card to other players** except when forced by the Snitch or when voluntarily revealing via Hostile Takeover.

The Chair may freely discuss their public goal (it's already public).

---

## Scoring Summary

Each Quarter, after the final trick:

1. All Agendas are revealed.
2. Each Executive scores their Agenda's points if its conditions were met.
3. The Chair scores 2 points if their public initiative was achieved.
4. Determine the next Chair (highest total score among Executives, ties go to current Chair).

Cumulative points across Quarters. Most points after the final Quarter wins.

---

## Open Design Questions

1. **Threshold for Hostile Takeover (5 Shares):** May need tuning. 5 of 9 Shares is majority; could be 6 for harder coalition victories.

2. **Number of Quarters per Fiscal Period (5):** Could be 4 or 6 depending on play length. We may need a new name, since "Fiscal Period" implies 4 Quarters.

3. **Hand size (10) and card count (61):** Fixed for now; playtest will validate.

4. **Auditor accusation timing:** Currently "any point during the Quarter." Could be restricted to end-of-Quarter, or to specific moments.

5. **Snitch's power level:** Forced agenda-reveal is dramatic but may be game-defining. Watch in playtest.

6. Proposal-layer Agendas: may feel awkward or may be the best part of the game. May require extra tokens to manage proposal counts.

7. **Whether Agenda points should scale with campaign progress** (similar to Final Run's Grade system) to add late-game pressure.

8. **The full Agenda deck** is currently 13 entries (with Hostile Takeover counted as one). May need 15-20 for variety. Playtest will determine the right size.

9. **The Number of Shares:** Maybe we should add more share cards. With six players, each player won't have many shares to work with.

---

## Designer Notes

- **The proposal mechanic is the engine.** Trick-taking is the substrate; the corporate-politics theater is in the proposals.
- **The Chair rotates.** Power is mobile. Whoever takes the most shares inherits the Chair seat and shapes the next Quarter's structure.
- **Hidden Agendas drive the game.** The deduction layer is the source of skill differentiation; experienced players read patterns better than newcomers.
- **Hostile Takeover is the marquee mechanic.** A coalition that must find itself, with a dramatic active reveal as its identification tool. The Auditor is its natural counter.
- **Tonal register:** 1980s corporate-thriller pulp. *Wall Street* via *Glengarry Glen Ross*. Suspenders. Saxophone.
