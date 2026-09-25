[繁體中文](README.md) | English

# GALAXIAN 2026 | 2D Arcade Shooter

A classic 2D browser-based scrolling shooter inspired by the formation and diving attacks of *Galaxian*, the weapon upgrades and screen-clearing bombs of *Raiden*, and the color-changing bell power-up system of *TwinBee*.

## Game Overview

- Pilot your fighter, dodge enemy fire, and shoot down enemies in formation or during diving attacks.
- Shoot floating bells to change their colors, then collect them to gain score bonuses, movement speed, firepower, shields, bombs, and other upgrades.
- Higher firepower levels unlock multi-directional shooting and homing missiles.
- A Boss battle appears every 3 stages, and Boss strength scales with the number of players in the room.
- Players opening the same service URL are matched automatically. Each room supports up to 8 players, and the server assigns each player a unique fighter color.
- If the WebSocket server cannot be reached, the game automatically falls back to local single-player mode.

## Screenshots

### Single-player Stage

![Single-player gameplay](docs/images/gameplay.png)

### Boss Battle

![Boss battle and bullet patterns](docs/images/boss-battle.png)

### Multiplayer

![Multiplayer gameplay](docs/images/multiplayer.png)

### 8 Players in One Room

![Eight-player gameplay](docs/images/eight-players.png)

## Running the Game

### Requirements

- Node.js (the current LTS release is recommended)
- npm

### Install and Start

```bash
git clone https://github.com/isbrian/Game-Space-Invaders.git
cd Game-Space-Invaders
npm ci
npm start
```

By default, the server starts at [http://localhost:8080](http://localhost:8080). Open the URL in a browser to play. Other players who connect to the same reachable service URL will automatically join a room.

To use a different port, set `PORT` when starting the server:

```bash
PORT=3000 npm start
```

Room and player counts can be viewed at [http://localhost:8080/stats](http://localhost:8080/stats).

## Controls

### Keyboard

| Action | Key |
|------|------|
| Move fighter | Arrow keys or `W` `A` `S` `D` |
| Shoot | `Space` or `J` |
| Drop screen-clearing bomb | `B` or `K` |
| Pause / Resume | `P` |
| Restart | Click **Start / Restart** |

### Mobile and Tablet

- Press and drag on the game screen to move the fighter; continuous fire is automatic.
- Tap **💣 Bomb** to use a screen-clearing bomb.
- Use the controls below the game area to start, pause, or toggle sound.

## Development and Testing

```bash
npm test
```

Browser, multiplayer, and 8-player end-to-end verification is implemented in [test/browser_check.py](test/browser_check.py).

## License

This project is licensed under the [MIT License](LICENSE). You may use, modify, and distribute it, including for commercial purposes.

When distributing this project or substantial portions of it, retain the original copyright notice and MIT License as required by the license terms to identify the source as [Game-Space-Invaders](https://github.com/isbrian/Game-Space-Invaders). The MIT License does not require author attribution to be displayed inside the game UI.
