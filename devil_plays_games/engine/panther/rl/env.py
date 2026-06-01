"""
env.py — Minimal Panther environment for curse-selection RL.

One episode = one hand.  The only learned decisions are the three curse
declarations (pass or a story).  Everything else uses heuristics:
  - choose_panther (2-story case): passer picks the story most likely to fail
  - choose_panther (3-story case): left-of-dealer self-selects
  - forced-Panic ground:          random
  - trick play:                   random (no pranks)

State  (125 floats): hand[45] + crow[45] + curse_pos[3] + prior_decls[32]
Action (16 ints):    0 = pass;  1–15 = (plan, ground) for 3 plans × 5 grounds
Reward (float):      points earned this hand by the deciding player
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Callable, Optional

import numpy as np

# ---------------------------------------------------------------------------
# Cards
# ---------------------------------------------------------------------------

SUITS      = ["Spades", "Diamonds", "Hearts", "Clubs"]
TRAD_RANKS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]   # 4=Prank, 11=J, 12=Q, 13=K  (no Ace: cardsPerSuit=10)
PERIL_RANKS = [21, 22, 23, 24, 25]


@dataclass(frozen=True)
class Card:
    suit: str
    rank: int
    idx:  int   # 0–44 for one-hot encoding

    def __repr__(self) -> str:
        name = {4: "Pr", 11: "J", 12: "Q", 13: "K", 14: "A"}.get(self.rank, str(self.rank))
        return f"{self.suit[:2]}{name}"


def _build_deck() -> list[Card]:
    cards: list[Card] = []
    for si, suit in enumerate(SUITS):
        for ri, rank in enumerate(TRAD_RANKS):
            cards.append(Card(suit, rank, si * 10 + ri))
    for ri, rank in enumerate(PERIL_RANKS):
        cards.append(Card("Perils", rank, 40 + ri))
    return cards


FULL_DECK: list[Card] = _build_deck()
assert len(FULL_DECK) == 45

# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------

PLANS   = ["Fight", "Run", "Vanish"]
GROUNDS: list[Optional[str]] = ["Spades", "Diamonds", "Hearts", "Clubs", None]

# Action 0 = pass.  Actions 1–15 = (plan, ground) in this order.
STORY_ACTIONS: list[tuple[str, Optional[str]]] = [
    (plan, ground) for plan in PLANS for ground in GROUNDS
]   # 15 stories
N_ACTIONS = 1 + len(STORY_ACTIONS)   # 16

def decode_action(a: int) -> Optional[tuple[str, Optional[str]]]:
    """None → pass;  (plan, ground) → story."""
    return None if a == 0 else STORY_ACTIONS[a - 1]

def encode_action(story: Optional[tuple[str, Optional[str]]]) -> int:
    if story is None:
        return 0
    return STORY_ACTIONS.index(story) + 1

# ---------------------------------------------------------------------------
# Scoring  (v2 point values as of current design iteration)
# ---------------------------------------------------------------------------

# Expected Hunter earnings = P(fail) × fail_bonus.
# Used by the heuristic choose_panther to pick adversarially.
_FAIL_EV: dict[str, float] = {
    "Fight": 1.10,   # ~55% fail × 2 pts
    "Vanish": 0.72,  # ~72% fail × 1 pt
    "Run":   0.55,   # ~55% fail × 1 pt
    "Panic": 0.42,   # ~42% fail × 1 pt
}


def _outcome(pt: int, ct: int, plan: str) -> str:
    s = pt + ct
    if plan == "Fight":
        if s >= 9: return "large"
        if s == 8: return "medium"
        if s == 7: return "small"
        return "fail"
    if plan == "Run":
        if s <= 1: return "large"
        if s == 2: return "medium"
        if s == 3: return "small"
        return "fail"
    if plan == "Vanish":
        return "large" if pt == 0 else "fail"
    if plan == "Panic":
        if s == 5: return "large"
        if s in (4, 6): return "medium"
        return "fail"
    raise ValueError(f"unknown plan: {plan!r}")


def score_hand(pt: int, ct: int, plan: str) -> tuple[int, int]:
    """Returns (panther_pts, hunter_pts_each)."""
    o = _outcome(pt, ct, plan)
    if plan == "Fight":
        return {"large": (4,0), "medium": (2,0), "small": (1,0), "fail": (0,2)}[o]
    if plan == "Run":
        return {"large": (4,0), "medium": (2,0), "small": (1,0), "fail": (0,1)}[o]
    if plan == "Vanish":
        return (3, 0) if o == "large" else (0, 1)
    if plan == "Panic":
        return {"large": (4,0), "medium": (2,0), "fail": (0,1)}[o]
    raise ValueError(f"unknown plan: {plan!r}")

# ---------------------------------------------------------------------------
# Trick play  (random, pranks ignored)
# ---------------------------------------------------------------------------

def _must_follow(hand: list[Card], led: Optional[str]) -> list[Card]:
    if led is None:
        return list(hand)
    same = [c for c in hand if c.suit == led]
    return same if same else list(hand)


def _strength(c: Card, led: str, trump: Optional[str]) -> tuple[int, int]:
    if c.suit == "Perils":           return (3, c.rank)
    if trump and c.suit == trump:    return (2, c.rank)
    if c.suit == led:                return (1, c.rank)
    return (0, c.rank)


def _play_random_tricks(
    hands:    dict[str, list[Card]],   # mutated in place
    seats:    list[tuple[str, str]],   # (player, zone); zone="crow" or player name
    lead:     int,                     # index into seats for first leader
    trump:    Optional[str],
    n_tricks: int,
    panther:  str,
) -> tuple[int, int]:
    """Returns (panther_solo_tricks, crow_tricks)."""
    p_won = c_won = 0
    for _ in range(n_tricks):
        led_suit: Optional[str] = None
        plays: list[tuple[int, Card]] = []
        for off in range(len(seats)):
            si = (lead + off) % len(seats)
            _, zone = seats[si]
            legal = _must_follow(hands[zone], led_suit)
            card  = random.choice(legal)
            hands[zone].remove(card)
            if led_suit is None:
                led_suit = card.suit
            plays.append((si, card))

        assert led_suit is not None
        best_si, best_c = plays[0]
        best_s = _strength(best_c, led_suit, trump)
        for si, c in plays[1:]:
            s = _strength(c, led_suit, trump)
            if s > best_s:
                best_s  = s
                best_si = si

        win_player, win_zone = seats[best_si]
        if   win_zone   == "crow":    c_won += 1
        elif win_player == panther:   p_won += 1
        lead = best_si

    return p_won, c_won

# ---------------------------------------------------------------------------
# State featurisation
# ---------------------------------------------------------------------------

STATE_DIM = 45 + 45 + 3 + 32   # 125


def featurise(
    hand:          list[Card],
    crow:          list[Card],
    curse_pos:     int,                  # 0 = left-of-dealer, 1, 2 = dealer
    prior_actions: list[Optional[int]],  # action indices for earlier curse positions
) -> np.ndarray:
    v = np.zeros(STATE_DIM, dtype=np.float32)
    for c in hand:   v[c.idx]      = 1.0   # 0–44:   own hand
    for c in crow:   v[45 + c.idx] = 1.0   # 45–89:  crow (public)
    v[90 + curse_pos] = 1.0                # 90–92:  curse position
    for i, a in enumerate(prior_actions[:2]):
        if a is not None:
            v[93 + i * 16 + a] = 1.0      # 93–124: prior declarations
    return v

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

Experience = tuple[np.ndarray, int, float]   # (state, action, reward)
PolicyFn   = Callable[[np.ndarray], int]      # state → action index


class PantherCurseEnv:
    """
    One episode = one full hand.

    All three curse declarations use the supplied policy.
    choose_panther and trick play use heuristics / random (see module docstring).

    `rollouts` independent random trick-play playthroughs are averaged per hand
    to reduce reward variance without requiring a smarter trick-play model.
    """

    def __init__(self, rollouts: int = 5):
        self.rollouts = rollouts
        self.players  = ["A", "B", "C"]

    def run_episode(self, policy: PolicyFn) -> list[Experience]:
        """
        Run one hand.  Returns one Experience per curse declaration (3 total).
        """
        # --- Deal -------------------------------------------------------
        deck = list(FULL_DECK)
        random.shuffle(deck)
        hands: dict[str, list[Card]] = {
            "A":    deck[0:10],
            "B":    deck[10:20],
            "C":    deck[20:30],
            "crow": deck[30:40],
            # woods: deck[40:45] — out of play, irrelevant here
        }
        crow = list(hands["crow"])   # snapshot for featurisation

        dealer_idx   = random.randint(0, 2)
        curse_order  = [
            self.players[(dealer_idx + 1) % 3],
            self.players[(dealer_idx + 2) % 3],
            self.players[dealer_idx],
        ]
        left_of_dealer = curse_order[0]

        # --- Curse declarations -----------------------------------------
        story_tellers: list[tuple[str, tuple[str, Optional[str]]]] = []
        passers:        list[str] = []
        prior_actions:  list[int] = []
        raw: list[tuple[np.ndarray, int, str]] = []   # (state, action, player)

        for pos, player in enumerate(curse_order):
            state  = featurise(hands[player], crow, pos, prior_actions)
            action = policy(state)
            raw.append((state, action, player))
            prior_actions.append(action)
            story = decode_action(action)
            if story is None:
                passers.append(player)
            else:
                story_tellers.append((player, story))

        # --- Resolution -------------------------------------------------
        panther, (plan, ground) = self._resolve(
            story_tellers, passers, left_of_dealer
        )
        trump = ground   # None → Perils Only

        # Seat order: Panther's hand, Hunter1, Crow, Hunter2
        others = [p for p in self.players if p != panther]
        seats: list[tuple[str, str]] = [
            (panther,   panther),    # panther's own hand (zone = player name)
            (others[0], others[0]),
            (panther,   "crow"),
            (others[1], others[1]),
        ]

        # --- Play tricks (averaged over `rollouts`) ----------------------
        p_pts_sum = h_pts_sum = 0.0
        for _ in range(self.rollouts):
            sim = {k: list(v) for k, v in hands.items()}
            pt, ct = _play_random_tricks(sim, seats, 0, trump, 10, panther)
            pp, hp = score_hand(pt, ct, plan)
            p_pts_sum += pp
            h_pts_sum += hp
        p_pts = p_pts_sum / self.rollouts
        h_pts = h_pts_sum / self.rollouts

        # --- Assign rewards ---------------------------------------------
        return [
            (state, action, p_pts if player == panther else h_pts)
            for state, action, player in raw
        ]

    # --------------------------------------------------------------------

    def _resolve(
        self,
        story_tellers: list[tuple[str, tuple[str, Optional[str]]]],
        passers:        list[str],
        left_of_dealer: str,
    ) -> tuple[str, tuple[str, Optional[str]]]:
        """Curse resolution → (panther, (plan, ground))."""
        n = len(story_tellers)

        if n == 0:
            # All passed → forced Panic with random ground
            return left_of_dealer, ("Panic", random.choice(GROUNDS))

        if n == 1:
            return story_tellers[0]

        if n == 2:
            # Passer is the chooser: pick the story most likely to fail
            # (maximises expected Hunter earnings)
            return max(story_tellers, key=lambda x: _FAIL_EV.get(x[1][0], 0))

        # n == 3: all declared — left-of-dealer self-selects
        self_story = next(
            (s for p, s in story_tellers if p == left_of_dealer), None
        )
        if self_story:
            return left_of_dealer, self_story
        # Fallback (shouldn't happen in a true 3-story case)
        return max(story_tellers, key=lambda x: _FAIL_EV.get(x[1][0], 0))
