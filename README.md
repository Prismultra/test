# Coin Rush 3D

A small third-person 3D platformer made with Godot 4 and set up to be edited and played on a phone in [Xogot](https://xogot.com).

Run around, jump up the stone steps and grab all 10 coins as fast as you can. After the last coin, the level restarts.

## Controls

| Action | Touch | Keyboard | Controller |
| --- | --- | --- | --- |
| Move | Drag on the left half of the screen (the joystick appears under your thumb) | WASD / arrow keys | Left stick |
| Look around | Drag on the right half of the screen | Mouse drag | — |
| Jump | Round button, bottom right | Space | A / Cross |

Turn your phone sideways to play.

## Opening it in Xogot

Pick one:

1. **Download from GitHub (inside Xogot):** use Xogot's *Download from GitHub* option and paste this repository's URL.
2. **Working Copy:** clone the repo with the Working Copy app, then open that folder from Xogot.
3. **ZIP:** download the repo as a ZIP, unzip it in the Files app, then open the folder in Xogot.

The first time you open it, Godot imports the project (it takes a few seconds). Then press **Play**.

## What's inside

```
project.godot              Project settings (input actions, mobile renderer)
scenes/main.tscn           The level: ground, platforms, coins, lights, HUD
scenes/player.tscn         The player character and its follow camera
scenes/coin.tscn           One coin (reused 10 times in the level)
scripts/player.gd          Running, jumping, gravity, camera turning
scripts/coin.gd            Spinning, bobbing, and getting picked up
scripts/main.gd            Coin counter, timer, and restart
scripts/touch_controls.gd  On-screen joystick, look area and jump button
```

Everything is built from Godot's built-in shapes, so there are no model or texture files to manage.

## Things to try next

- **More coins:** in `main.tscn`, select a coin under *Coins*, duplicate it and move it. The counter picks it up on its own.
- **New platforms:** duplicate one of the boxes under *Level* and change its *Size* and position.
- **Tune the feel:** select *Player* and change *Speed*, *Jump Velocity* or *Gravity Scale* in the Inspector.
- **Enemies or hazards:** add an `Area3D` that calls `respawn()` on the player when touched.
