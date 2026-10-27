# Dot Party



A turn-based deduction party game for exactly 2 players. Each player joins from their own device using a 4-letter room code. 

Player names must be unique within a room (case-insensitive).

The system holds a secret line of 5 dots drawn from 8 colors (no repeats). 

Players take 30-second turns arranging a private board and submitting guesses.

Only the guesser learns which of their dots were correct — as green (right color + right spot) or yellow (right color, wrong spot). 

Everyone sees the submitted sequence, permanently, so shared knowledge builds up as a "known wrong" list.



## Run

```bash
npm install
npm start
```


Open http://localhost:3000 in two browser tabs, or on two devices on the same network using your machine's LAN IP.

## Rules

\- 2 players, 4-letter room code. 8 colors, 5 dots, no duplicate colors.

\- Turn 1: place all 5 dots. After that: rearrange freely. 30 seconds per turn.

\- Cannot submit with fewer than 5 dots; cannot re-submit any sequence already in the public log (all logged sequences are known wrong).

\- Timeout = public SKIPPED. Two consecutive skips = removed from the game.

\- On submit: The guesser privately sees green (right color + spot) and yellow (right color, wrong spot) outlines on their own guess, in their own history.

\- Everyone sees the submitted sequence, with no outlines, permanently.

\- Each turn starts with an empty board. Your confirmed greens and the set of colors present in the secret stay visible as a text reference above the board; you re-place them yourself.

\- Scoring: +10 to the first player to place a dot exactly right (50-point pool, one claim per dot). +20 for solving, which ends the game. Highest score wins; solver wins ties.

\- Turn order alternates. Room is deleted when both players leave.

\- When a game ends, both players can vote for a rematch from the results screen; the game restarts the moment both have agreed.


## Play time



2 players, green/yellow feedback: about 3–5 minutes per game.



## Tuning

`server.js` → `CONFIG`:

\- `COLORS` — lower it to 6 for easier / faster games.

\- `TURN\_MS` — length of each turn in milliseconds.

\- `SKIPS\_TO\_KICK` — consecutive skips before a player is removed.

\- `DOT\_POINTS` / `SOLVE\_BONUS` — scoring weights.

