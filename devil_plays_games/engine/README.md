# engine

Card game substrate: event log, zone/visibility model, async decision loop.

## Requirements

[mise](https://mise.jdx.dev) must be installed. It manages the Node version.

## Setup

```
just up
```

This installs the pinned Node version, installs dependencies, and runs the test suite.

## Commands

```
just test     # run the test suite
just panther  # run the Panther reference game
just check    # type-check without running
```
