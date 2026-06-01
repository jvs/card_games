"""
train.py — REINFORCE training for Panther curse-selection.

All three seats share one policy.  Each curse declaration in an episode
contributes one gradient update weighted by that player's hand outcome.

Usage:
    python train.py                       # 50k episodes, defaults
    EPISODES=200000 LR=1e-4 python train.py

Output:
    curse_policy.pt   — saved policy weights
    Progress printed every EVAL_EVERY episodes.
"""

from __future__ import annotations

import os
import random
from collections import deque
from typing import Optional

import numpy as np
import torch
import torch.nn as nn

from env import (
    PantherCurseEnv, STATE_DIM, N_ACTIONS,
    PLANS, GROUNDS, decode_action,
)

# ---------------------------------------------------------------------------
# Policy network
# ---------------------------------------------------------------------------

class PolicyNet(nn.Module):
    def __init__(self, hidden: int = 128):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(STATE_DIM, hidden), nn.ReLU(),
            nn.Linear(hidden,    hidden), nn.ReLU(),
            nn.Linear(hidden, N_ACTIONS),
        )

    def log_probs(self, x: torch.Tensor) -> torch.Tensor:
        return torch.log_softmax(self.net(x), dim=-1)

    @torch.no_grad()
    def sample(self, state: np.ndarray) -> int:
        lp = self.log_probs(torch.FloatTensor(state).unsqueeze(0)).squeeze()
        return int(torch.multinomial(lp.exp(), 1).item())

    @torch.no_grad()
    def greedy(self, state: np.ndarray) -> int:
        lp = self.log_probs(torch.FloatTensor(state).unsqueeze(0)).squeeze()
        return int(lp.argmax().item())

# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def train(
    n_episodes:    int   = 50_000,
    lr:            float = 3e-4,
    entropy_coeff: float = 0.01,    # prevents premature collapse to one action
    rollouts:      int   = 5,       # trick-play rollouts per episode (variance reduction)
    eval_every:    int   = 2_000,
    eval_episodes: int   = 500,
) -> PolicyNet:

    env    = PantherCurseEnv(rollouts=rollouts)
    policy = PolicyNet()
    optim  = torch.optim.Adam(policy.parameters(), lr=lr)

    baseline      = 0.0    # exponential moving average of mean reward
    recent_return = deque(maxlen=500)

    for ep in range(1, n_episodes + 1):
        experiences = env.run_episode(policy.sample)

        states  = torch.FloatTensor(np.stack([s for s, _, _ in experiences]))
        actions = torch.LongTensor([a for _, a, _ in experiences])
        rewards = torch.FloatTensor([r for _, _, r in experiences])

        advantages = rewards - baseline

        log_probs = policy.log_probs(states)                     # (3, 16)
        chosen_lp = log_probs.gather(1, actions.unsqueeze(1)).squeeze(1)
        entropy   = -(log_probs.exp() * log_probs).sum(dim=1).mean()

        loss = -(chosen_lp * advantages).mean() - entropy_coeff * entropy

        optim.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(policy.parameters(), 1.0)
        optim.step()

        avg_r    = rewards.mean().item()
        baseline = 0.95 * baseline + 0.05 * avg_r
        recent_return.append(avg_r)

        if ep % eval_every == 0:
            stats = evaluate(policy, eval_episodes, rollouts)
            print(
                f"ep {ep:6d} | "
                f"return {sum(recent_return)/len(recent_return):.3f} | "
                f"pass {stats['pass_rate']:.0%}  "
                f"fight {stats['fight_rate']:.0%}  "
                f"run {stats['run_rate']:.0%}  "
                f"vanish {stats['vanish_rate']:.0%}  "
                f"panic {stats['panic_rate']:.0%}"
            )

    return policy

# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def evaluate(
    policy:    PolicyNet,
    n_episodes: int = 1_000,
    rollouts:   int = 5,
) -> dict:
    env = PantherCurseEnv(rollouts=rollouts)

    plan_counts   = {p: 0 for p in [*PLANS, "Panic", "pass"]}
    ground_counts = {(g if g else "Perils"): 0 for g in GROUNDS}
    total_reward  = 0.0
    total_n       = 0

    for _ in range(n_episodes):
        for _, action, reward in env.run_episode(policy.sample):
            story = decode_action(action)
            if story is None:
                plan_counts["pass"] += 1
            else:
                plan, ground = story
                plan_counts[plan] += 1
                ground_counts[ground if ground else "Perils"] += 1
            total_reward += reward
            total_n += 1

    n_stories = total_n - plan_counts["pass"]
    return {
        "avg_return":   total_reward / total_n,
        "pass_rate":    plan_counts["pass"]   / total_n,
        "fight_rate":   plan_counts["Fight"]  / total_n,
        "run_rate":     plan_counts["Run"]    / total_n,
        "vanish_rate":  plan_counts["Vanish"] / total_n,
        "panic_rate":   plan_counts["Panic"]  / total_n,
        "ground_dist":  {
            k: v / max(n_stories, 1)
            for k, v in ground_counts.items()
        },
    }


def print_eval(stats: dict) -> None:
    print(f"\n  Avg return : {stats['avg_return']:.3f}")
    print(f"  Pass       : {stats['pass_rate']:.1%}")
    print(f"  Fight      : {stats['fight_rate']:.1%}")
    print(f"  Run        : {stats['run_rate']:.1%}")
    print(f"  Vanish     : {stats['vanish_rate']:.1%}")
    print(f"  Panic      : {stats['panic_rate']:.1%}")
    gd = stats["ground_dist"]
    print(f"  Ground     : " + "  ".join(
        f"{k} {v:.0%}" for k, v in sorted(gd.items(), key=lambda x: -x[1])
    ))

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    n_ep     = int(os.environ.get("EPISODES",  "50000"))
    lr       = float(os.environ.get("LR",      "3e-4"))
    rollouts = int(os.environ.get("ROLLOUTS",  "5"))

    print(f"Panther curse-selection RL")
    print(f"  episodes={n_ep}  lr={lr}  rollouts={rollouts}")
    print(f"  state_dim={STATE_DIM}  n_actions={N_ACTIONS}\n")

    # Baseline: random policy stats
    random_policy = PolicyNet()
    nn.init.constant_(random_policy.net[-1].weight, 0)
    nn.init.constant_(random_policy.net[-1].bias, 0)
    print("Random policy baseline:")
    print_eval(evaluate(random_policy, 500, rollouts))
    print()

    policy = train(n_episodes=n_ep, lr=lr, rollouts=rollouts)

    print("\n=== Final evaluation (1 000 episodes) ===")
    print_eval(evaluate(policy, 1_000, rollouts))

    torch.save(policy.state_dict(), "curse_policy.pt")
    print("\nSaved: curse_policy.pt")
