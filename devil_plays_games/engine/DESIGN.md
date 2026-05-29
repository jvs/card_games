# engine — design notes

This document records the **non-obvious constraints** behind the engine: the
decisions that the code embodies but doesn't explain, and the reasoning that
keeps the core small. If you're picking this up fresh (or handing it to someone
who is), read this before adding anything to `core.ts`.

The single most important rule is at the bottom: **don't add a primitive to the
core without a concrete game that currently demands it.** The core is small
because that rule was applied ruthlessly; every violation re-bloats it.

---

## What the core is, in one paragraph

An event-sourced engine for turn-based games with hidden information. The
**event log is the source of truth**; all visible game state is a projection of
it. Every event carries an **audience tag** (`seenBy`), so the same log projects
to a *different view per player* — that's how concealed hands and secret roles
work, rather than being bolted on. Game rules are a **generator coroutine** that
*yields a decision request* and is *resumed with the answer*; this makes the
rules a pure description of *what* decisions occur, while *who decides* (human,
AI, random, network socket, replay script) is a pluggable `Answerer` swapped at
the boundary. One rules description therefore runs unchanged as a single-player
game, a multiplayer server, a training simulator, and a deterministic test.

Conceptually: the Interpreter pattern over an algebraic-effects loop, with event
sourcing underneath and per-observer projection as the read model.

---

## File layout

- `core.ts` — the card-agnostic substrate. Log, projection (`viewFor`), the two
  effects (`Choice`, `Commit`), `Answerer`, the async `run` driver, and a
  seedable `Rng`. Knows nothing about cards. ~175 lines.
- `cards.ts` — the card layer built on core: `Card`, `Zone` + `Vis`,
  `deal`/`move`/`shuffle`, `Secret`, `Question`, and the `State` subclass that
  card games instantiate. Re-exports core so a game imports only from here.
- `panther.ts` — the reference game (a 3-player trick-taker). The worked example.
- `testing.ts` — `ScriptedAnswerer`, kept out of core because it's test infra.
- `test_substrate.ts` — 16 executable guarantees; the core's regression net.

---

## The constraints (the part that isn't visible in the code)

### 1. Randomness flows through the answerer boundary, for reproducibility.

Game logic must never call `Math.random` or `rng` directly for a *decision*.
Shuffling a deck is fine to do directly (it's bulk setup), but any random
*outcome the rules branch on* should be a `roll()` — a uniform `Choice`
addressed to the reserved `RNG` seat. Why: it makes every run reproducible from
(seed + answer stream) and lets a test or replay *script* a "random" outcome the
same way it scripts a player's move. Randomness is not special; it's a choice the
RNG answers.

Corollary: **the engine only does uniform choice.** Weighted randomness is a
game-layer concern — expand the outcome into a uniform pool (7 of A, 3 of B for
70/30) and map the pick back. The game holds that mapping; the core stays
uniform-only. (We had explicit weights once and removed them: a uniform choice
over a pre-expanded pool subsumes them, and removing them made the RNG seat
identical in shape to a player seat.)

### 2. The log is the source of truth; live state is a cache of it.

`emit()` is **append-only** — it never mutates game state. The cards layer's
mutating methods (`move`, `deal`, …) change a zone *and* `emit` in the same
method, so the log and the derived state can't drift, but the *core* never needs
to know what derived state exists. This is the load-bearing reason the core and
the card layer could be separated at all.

Practical consequence: don't cache anything derived in the core. If a future
query needs grouping (e.g. "all events in trick 3"), compute it as a pass over
the log, don't stamp every event. (We had a `mark` field for exactly this and
cut it: the log is single-threaded and uninterleaved, so round boundaries are
*reconstructable* from the events already present — unlike a distributed
trace-id, which must be stamped because interleaving destroys the ordering.)

### 3. Visibility is per-event, and projection does NO redaction.

Each event carries `seenBy` (either `null` = everyone, or a `Set<Player>`).
`viewFor(player)` is *pure filtering*: keep the events visible to that player,
full stop. There is deliberately **no per-viewer rewriting** of an event's
contents.

The consequence you must internalize: if you want the public to learn *that*
something happened but not *what*, you emit **two events at two visibilities** —
a private detail event (`seenBy` = the parties) and a public fact event
(`seenBy` = null). Example: the "Devil" card swap emits the card identities to
the two players involved and a separate "a swap happened" to everyone. Do NOT
reach for a redaction/scrub step in `viewFor`; we had one, found no game needed
it, and removing it is what made `viewFor` a one-liner and let zones leave the
core. Visibility is declared at emit time by the game, not inferred by the
engine.

Subtle but intended: a player can see the `seq` numbers *jump* where a hidden
event was (their view is filtered, not renumbered), so they correctly know
"something I can't see happened here" — which is the right epistemic state for
an opponent.

### 4. The option set of a `Choice` is private and never logged.

A `Choice` is consumed by exactly one answerer and is never emitted. Only the
*chosen* result becomes an event (if the game emits it). This is why
**role-dependent legality needs no special machinery and leaks nothing**: you
can legally offer the undercover agent "any card" and offer everyone else
"follow suit," computed from secret role state, and no observer can tell, because
nobody sees anyone else's menu — they only see the card played, and that's
already ambiguous (a snipe looks like an honest void).

We explicitly considered and *rejected* an "offered options vs. post-hoc
legality check" split for this. It isn't needed: per-player legality from the
ground-truth state handles it, because menus are private. The only reason to add
post-hoc legality would be to faithfully simulate the *tabletop* social mechanic
of making an illegal play as a bluff and being "called out" — a fidelity choice,
not a structural requirement, and a per-game addition if ever wanted.

### 5. Simultaneous play is its own primitive: `Commit`.

Sequential `Choice`s leak: if five players "simultaneously" commit by yielding
five `Choice`s in a row, the later deciders' answers can depend on the earlier
ones (an agent could peek at what's already been answered). `Commit` collects
every player's decision against the **same pre-commit state**, and the game only
emits the reveals *after* all are collected. In the async driver these are
gathered with `Promise.all` (concurrent, so real network seats don't queue up
and leak timing), and the result is keyed by player, so **arrival order cannot
affect the outcome** — the reveal order in the log is deterministic game-order,
not network-order. (`test_substrate.ts` proves this with out-of-order async
seats.)

### 6. Only the answer boundary is async; game logic is synchronous.

`Answerer.answer` may return a value or a `Promise`. `run` is `async` and awaits
each answer. But the **game generator never becomes async** — only *obtaining*
each answer is awaited, never the game's own stepping. Sync seats (random,
scripted, local UI) return plain values and an `await` of a non-Promise is a free
tick. This is the whole networking story: a socket seat awaits a websocket
message, an AI seat awaits inference, and the rules files don't change a line.
`viewFor(player)` is the packet you send each client.

### 7. Questions are opaque predicate *source*, compiled at the one wasm seam.

The yes/no question cards (Snitch, etc.) take a `Question` carrying a
*source string* plus an input-kind tag (`HAND_PUBLIC` = `(hand, public) -> bool`,
or `PLAYER_VIEW` = `(targetView) -> bool`). The engine compiles and runs it; it
holds ground truth, so it supplies the input. The *production* of these strings
is a **separate project** (a query DSL) — the engine only consumes them. This is
also the one place a wasm module legitimately belongs: value-in / bool-out, no
host interaction. (`new Function` is used now; it's `eval`-class and assumes the
source is trusted — fine for self-authored DSL output, a hole if it ever isn't.)

---

## The meta-rule: how the core stayed small

Every primitive in the core earns its place by a **current game that demands
it**. Things were repeatedly *removed* when that test failed: explicit weighted
randomness, a custom event-handler/reducer registry, an "unordered zone" flag, a
function-wrapping answerer, the `Roll` effect type, a redaction step in
`viewFor`, the `mark` grouping field, and the offered-vs-legal split. Each was a
*generalization added in anticipation* of a need that didn't materialize.

The two primitives that **did** survive on this test, and weren't obvious up
front, are `Commit` (simultaneous play) and `Secret` (per-player hidden state
whose audience changes over time — an agenda that gets revealed, a badge that
flips). Those came from games that genuinely needed them (The Chair, Secret
Agent).

So: when tempted to add to `core.ts`, name the game and the turn in it that
can't be expressed without your addition. If you can't, it belongs in the card
layer, the specific game, or nowhere yet. A fresh context will be tempted to
re-add the generality listed above — resist it.

---

## Known gaps / not-yet-done

- Only `panther.ts` is implemented; Chair, Secret Agent, and the other four
  games are not yet written against the substrate.
- No real networking/serialization yet. The log is *designed* to serialize
  (`seenBy` is `null | Set`, not a sentinel), but `Set` doesn't survive
  `JSON.stringify` as-is — a real transport needs a small encode/decode step.
- The question DSL (string producer) does not exist; games stub fixed predicates.
- Scoring/balance numbers in the games (e.g. Panther's point values) are
  placeholders, not tuned against any simulation.
