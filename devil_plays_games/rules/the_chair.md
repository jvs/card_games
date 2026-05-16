# The Chair

A six-player trick-taking game of corporate politics.

(Work in progress)

---

## Premise

Six players. One holds **the Chair**. The other five are **Executives**, each with a hidden **Agenda**. Over the course of five brutal quarters, players compete for tricks, for shares, and of course, for the Chair. 

Take the elevator to the top floor, where the seats are high and the stakes are higher. Welcome to the boardroom. This is your Chair.

---

## Components

### Playing Deck (61 cards)

**Four standard suits**
- Spades, Hearts, Diamonds, Clubs
- 13 cards each (52 total): Prank (2), 3-10, Jack, Queen, King, Ace.

Standard rank order. Ace high. (The 2 of each suit is also that suit's Prank card — see below.)

**Shares** (the trump suit) — 9 cards:

Penny Share, 2-8, Golden Share.

Penny Share is the lowest. Golden Share is the highest. Any Share beats any non-Share card regardless of rank.

**Prank cards** — 4 cards, one per traditional suit, replacing the 2 in that suit:

- **The Cat** (Clubs)
- **The Devil** (Diamonds)
- **The Hound** (Hearts)
- **The Snitch** (Spades)

Pranks are the lowest card in their suit. See *Prank Card Effects* below.

### Agenda Deck

~14 Agenda cards. Each Executive draws one secret Agenda per Quarter. See *Agendas* below.

### Chair Goals Deck

~13 Chair Goal cards. The current Chair has one public goal per Quarter. See *Chair Goals* below.

### Chair Powers Deck

~13 Chair Power cards. The current Chair has one public Chair Power per Quarter. See *Chair Powers* below.

### Leader Tokens

10 tokens to track the leader of each trick.

---

## The Term

Each game is played over a Term — a fixed number of Quarters, typically five. Most points at the end wins.

### Setup

1. Players agree on Term length (default: 5 Quarters).
2. Choose the first Chair arbitrarily (random draw, oldest player, etc.).
3. Begin Quarter 1.

### Each Quarter

1. **Chair Goal:** The Chair draws two Chair Goal cards, selects one, and places it face-up on the table. This is their victory condition for the Quarter. The other Goal card is returned to the deck.
2. **Chair Power:** The Chair draws two Chair Power cards, selects one, and places it face-up on the table. The other Power card is returned to the deck. A Chair Power is a special ability the Chair may use once during the Quarter.
3. **Executive Agendas:** Each Executive draws one Agenda card, looks at it secretly, and keeps it face-down.
4. **Deal:** Shuffle the playing deck. Deal 10 cards to each player. Put the last card face-down. This card is unused.
5. **Play 10 sprints** using the Sprint Cycle rules.
6. **Chair Rotation:** To take the Chair, an Executive must finish the Quarter with more Share *cards* in their won tricks than any other player. Without a clear winner, for example ties, the Chair retains the seat.
7. **Score:** At the end of the Quarter, after determining the next Chair, all Agendas are revealed. Score points for any Agenda whose conditions were met. Score the Chair Goal if achieved.
8. **Retirement:** The current Chair discards their Goal and Power cards, removing them from play for the rest of the Term. Return all Leader tokens to the supply.

### Winner of the Game

After the final Quarter, the player with the most cumulative points wins. Ties stand.

---

## The Sprint Cycle

Each sprint starts with proposals from all the Executives.

### Each Sprint

1. **Sprint Planning:**
   - Each Executive selects one card from their hand and places it face-down on the table. This is their proposal for the sprint.
   - Once all proposals are placed, the Chair tells Executives to reveal their proposals simultaneously.
   - If an Executive has *Lead Information Advantage*, they select a card from their hand and present their proposal now, after all the other Executives have revealed their proposals. See *Lead Information Advantage*.
2. **Chair Approval:**
   - The Chair reviews the proposals.
   - Before Chair approves one, the Chair may optionally use their quarterly Chair Power.
   - Next, the Chair approves one proposal, passing the Executive a Leader token.
   - The selected card becomes the **lead card** for this trick.
   - (Special case: a player with a face-down Agenda may reveal their Agenda at this moment to override the Chair's approval.)
3. **Deliverables:**
   - Rejected Executives return their proposal cards to their hand.
   - Each Executive then plays one card face-down as their deliverable.
   - Once all deliverables are placed, the Chair tells Executives to reveal their deliverables simultaneously.
4. **The Call:**
   - The Chair reviews all the deliverable for this sprint.
   - Before making the Call, the Chair may optionally use their quarterly Chair Power.
   - Then the Chair plays a card from their hand, following suit if possible.
5. **Parking Lot Items:**
   - Prank cards resolve their effects now (see *Prank Card Effects*).
6. **Regulatory Reporting:**
   - The trick is resolved: highest Share wins. Otherwise, highest card of the lead suit wins.
   - The winner collects the cards into their trick pile.

### Following Suit

When playing their deliverable, Executives must follow the lead suit if they have any cards of that suit in their hand. If they have no cards of the lead suit, they may play any card.

Similarly, when the Chair plays their card, they must follow the lead suit if possible. If they have no cards of the lead suit, they may play any card.

### Proposal Rules

- Executives may propose any card from their hand.
- An Executive whose proposal is selected does *not* play a deliverable that trick — their proposal *is* their card for that trick.
- Rejected Executives return their proposal to hand and play a deliverable normally,
- All other players (including The Chair) must follow suit if they can. Otherwise, they may play any card.

### Lead Information Advantage

When an Executive wins a trick, they also gain Lead Information Advantage during the next sprint. The Executive selects and presents their proposal after all the other Executives have revealed their proposals, giving them the opportunity to see what their competitors are proposing before making their own proposal.

---

## Prank Card Effects

Prank effects resolve after the Chair plays but before the trick is resolved. If multiple Pranks are played in the same trick, they resolve in alphabetical order: Cat, Devil, Hound, Snitch.

### The Cat (Clubs Prank)

The Cat-player names any one Executive. The Cat-player may name themselves. During the next Chair Approval, the named Executive tells the Chair which proposal to accept.


### The Devil (Diamonds Prank)

The Devil-player names two other players (one may be themselves). Those two players must exchange one card face-down from their hands. Only those two players know the identity of the exchanged cards.

### The Hound (Hearts Prank)

When revealed, the Hound-player names one Executive and secretly looks at that Executive's hand. The Hound-player may not target the Chair, only Executives.

### The Snitch (Spades Prank)

When revealed, the Snitch-player names one Executive. That Executive must flip their Agenda card face-up for the rest of the Quarter. Their Agenda is now public knowledge.

---

## Chair Powers

The Chair draws two random Power cards at the start of each Quarter and chooses one to keep. The other is returned to the deck. The selected Chair Power is kept face-up on the table until it is used, at which point it is flipped face-down.

The Chair may optionally use their power during the Chair Approval, before approving a proposal.

**Audit**
- The Chair may call for an Audit, targeting one Executive.
- The Executive shows their Agenda to the chair.
- The Chair may then decide whether or not to flip the Agenda face up for the rest of the Quarter. If flipped face-up, the Executive's Agenda is now public knowledge.

**You’re on mute**
- Special: This power may only be played during Chair Approval.
- Target one Executive.
- Their proposal is placed on the table face-down.
- The face-down card is included in the sprint, but has no effect and cannot win the trick.
- The target player does not play a deliverable this sprint.

**Restate Earnings**
- The Chair targets one Executive, looks through their won tricks, and selects one trick.
- The Chair removes one card from the trick and adds it to their own hand.
- The Chair takes a card from their hand and adds it to the Executive’s won trick.

**Reorg**
- The Chair puts their hand face down on the table.
- The Chair names three Executives.
- Their proposals remain face-up on the table.
- Each named Executive secretly passes one card from their hand to the Chair.
- The Chair looks at the three cards, and secretly passes one card back to each of the three Executives.

**Design by committee**
- Special: This power may only be played during Chair Approval.
- Each Executive picks up their current proposal and returns it to their hand.
- The Chair makes two proposals, placing two cards from their hand face-up on the table.
- Executives vote on them.
- Executives with face up hostile Agendas don’t get to vote.
- The winning proposal becomes the lead card for the sprint.
- Chair breaks ties.

**PIP**
- Special: This power may only be played during The Call.
- Target one Executive. That Executive must play an additional card for the current trick. Follow suit rules still apply.
- The Executive then takes their original deliverable and adds it to their hand.

**Waterfall**
- Special: This power may only be played during Chair Approval.
- Each Executive places one card face-down in front of them.
- Once all cards are placed, all Executives reveal their submitted cards simultaneously.
- During the next Sprint Planning, each Executive must select their face-up card as their proposal. They cannot select a card from their hand.
- If the proposal is rejected, the Executive returns the rejected card to their hand, as usual.

**Mission Statement**
- The Chair names a suit.
- That suit acts as the greater Trump during the next sprint.
- The greater trump suit beats Shares, even Golden Shares.

**Promotion**
- Target one Executive and place this card face-up in front of them.
- They become Vice Chair for the remainder of the Quarter.
- The Vice Chair scores +1 if the Chair achieves their goal, and -1 if the Chair fails it.

**Performance Bonus**
- Name any card, for example "Jack of Hearts".
- If an executive has the nammed card in their hand, they may reveal it.
- You may add the revealed card to your hand, secretly exchanging it for a card from your hand.
- The Executive immediately adds +1 to their score.

**I need ideas, people!**
- Special: This power may only be played during Chair Approval.
- Name a suit.
- Executives leave their current proposal face-up on the table and place a second proposal face-down on the table as a second proposal.
- If the Executive has a card of the named suit, this second proposal must be of the named suit.
- Once all proposals are placed, all proposals are revealed simultaneously.
- The sprint then proceeds as normal, only with more proposals this time.

**Status Update:**
- The Chair names a suit.
- Each Executive must reveal a card of that suit.
- If the Executive does not have a card of that suit, they must show any one card from their hand.

**Executive Order:**
- Special: This power may only be played during Chair Approval.
- All proposals are placed on the table, forming a trick.
- The Chair adds any card from their hand to the trick, and then automatically wins the trick.

**Loyalty Test**
- Starting with the Executive to the left of the chair, each Executive with a face-down Agenda must complete a loyalty test.
- To complete a loyalty test, the Executive passes their Agenda card to any other Executive with a face-down Agenda.
- The second Executive looks at the first Executive's Agenda, then declares whether the Agenda is loyal, neutral, or hostile.
- If the reviewed Agenda is hostile, the second Executive may lie and declare that it is loyal or neutral.
- (Lying is only allowed when the reviewed Agenda is hostile.)

---

## Chair Goals

The Chair draws one Chair Goal card per Quarter. The goal is public — all Executives can see what the Chair is playing for. Achieving the Goal scores 2 points for the Chair.

### Example Chair Goals

**Trick Count Goals**

**Maximize Shareholder Value:** The Chair wins the most tricks (more than any individual Executive).

**Reduce Headcount:** At least one Executive wins zero tricks.

**Training and Development:** Every Executive wins at least one trick.

**Cut Costs:** No Executive wins more than 3 tricks. (TODO: Consider changing this to 2 tricks.)


**Trick Content Goals**

**Set a New Standard:** At least one card of each suit is present in your won tricks.

**Operational Efficiency**: At least two Executives won tricks where three or more cards have the same suit.

**Diversity and Inclusion:** At least two Executives each have at least one King, one Queen, and one Jack in their won tricks.

**Drive Innovation:** At least three players each have a Prank card in their won tricks. (You may count a Prank card in the Chair's won tricks for this goal.)

**Stock Buybacks:** No Executive has more than 3 Share cards in their won tricks. (TODO: Consider changing this to 2 Share cards.)


**Loyalty Goals**

**Company Culture:** Add the number of tricks won by The Chair and all Executives with loyal Agendas. The total must be at least 5.

**Foreign Investment:** Add the number of tricks won by all Executives with nuetral Agendas. The total must be at least 2. If no Executives have a neutral Agenda, this goal is automatically achieved.

**Chair Rotation Goals**

**Leadership Development:** Another player takes the Chair next Quarter.

**Strategic Vision:** Stay on as Chair next Quarter.

---

## Agendas

Each Executive draws one Agenda per Quarter. Each Agenda is hidden until the end of the Quarter, unless a special card reveals it.

Each Agenda has a printed point value: 1, 2, or 3 points.

Each Agenda also has a loyalty: loyal, neutral, or hostile.


### Trick-Count Agendas

**Climb the Ladder** *(2 points, hostile)*
Win the most tricks of any Executive. (Ties don't count.)

**Severance Package** *(2 points, neutral)*
Win zero tricks.

**Hard Stop at 2** *(1 point, loyal)*
Win exactly 2 tricks.

**Corporate Infighting** *(2 points, hostile)*
At least one other Executive wins zero tricks.

### Trick-Content Agendas

**Vanity Project** *(1 point, neutral)*
Win at least one Ace.

**Stockpile** *(2 points, hostile)*
Win at least 3 Share cards.

**Cover All Your Bases** *(2 points, neutral)*
Have at least one card of each suit in your won tricks.

**Think Outside the Box** *(1 point, loyal)*
Win at least one trick containing a Prank card.

### Proposal-Layer Agendas

**On The Boss's Radar** *(2 points, loyal)*
Have the most Leader tokens among Executives. (Ties don't count.)

**Keep Your Head Down** *(1 point, neutral)*
Have the fewest Leader tokens among Executives. (Ties don't count.)

**Boil The Ocean** *(3 points, hostile)*
Have zero Leader tokens at the end of the quarter.


### Chair-Goal Agendas

**Corporate Sabotage** *(3 points, hostile)*
The Chair fails their goal.

**Dedication to the Company** *(1 point, loyal)*
The Chair achieves their goal.


### Loyalty Agendas

**Hostile Takeover** *(2 points, hostile)*
Add the number of Share cards won by all Executives with hostile Agendas. The total must be at least 5.
- Special: If you achieve this Agenda, ignore the results of Chair Rotation and take the Chair next Quarter.
- Special: Score this Agenda first, before any other Agendas.


## Loyalty Rules

### Loyal agendas:
- During Chair rotation, if the loyal player would take the Chair, the current Chair stays on, and does not switch.
- If the current Chair keeps the seat for any reason, you get +1 point.
- Reveal mechanic: when you win a trick, you may flip your Agenda card face-up. If you do so, the Chair wins the trick instead.

### Hostile agendas:
- If you or another hostile player takes the Chair, immediately score +1 point.
- Reveal mechanic: During any trick's proposal phase, after proposals are revealed face-up but before the Chair approves one, you may flip your Agenda card face-up. If you do, your proposal is automatically approved for that trick, skipping the Chair's Approval Phase.


---

## Communication

Players may talk freely during the game. Lying about your Agenda or your cards is allowed.

However, **you may not show your Agenda card to other players** unless expressly allowed by a card effect.

---

## Scoring Summary

Each Quarter, after the final trick:

1. Determine the next Chair (highest total score among Executives, ties go to current Chair). Do this first, since it can affect the scoring of some Agendas.
2. All Agendas are revealed. If one of the Agendas is Hostile Takeover, score it first, since it may override the Chair rotation.
3. Each Executive scores their Agenda's points if its conditions were met.
4. The Chair scores 2 points if their Goal was achieved.

Cumulative points across Quarters. Most points after the final Quarter wins.
