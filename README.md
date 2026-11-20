# RAGDOLL DUELISTS

A 3D physics sword-fighting game for **phones**. Two wobbly stickmen duel with shiny swords on a round beige platform high above the clouds. Everything is physics: they walk by actually stepping with their feet, balance on their legs, swing real heavy swords, and can lose their footing and fall.

- 📱 **Mobile only**: two thumbs, landscape. Desktop browsers get a "made for phones" screen.
- 🧍 **14-part physical stickmen**: head, torso, upper arm / forearm / ball hand ×2, thigh / shin / rounded foot ×2, plus the sword in both hands.
- 🗡️ **Real cutting**: a fast edge cuts *into* a limb, and the deeper it goes the more damage it does. Go ~80 % through and the limb comes off. Thrusts **stab**: through a limb disables it, and the heart or head kills instantly.
- 🩸 **Bleeding**: wounds and stumps bleed and slowly clot. The health bar shows how much health you are still going to lose (the striped light-red part).
- 🏆 **Rounds**: first to 3. If your opponent dies, the round keeps going while you are still bleeding. Survive your own bleeding to score; if you both die, it's a draw.
- 🤖 **Bots, level 1–10**: they play with the same two joysticks as you.
- 🌐 **Online**: Quick Match (random public opponent) or Private Match (5-letter code), peer-to-peer.
- No build step, no server to pay for: static files only.

---

## ▶️ Put it online (free) — GitHub Pages

1. Make this repository **public** (Settings → General → Danger Zone → Change visibility), or use a paid plan.
2. Go to **Settings → Pages**.
3. **Build and deployment**: Source = **Deploy from a branch**, Branch = the branch with this code (for example `main` after merging, or `claude/ragdoll-duelists-game-f503u0`), folder = **/ (root)** → **Save**.
4. After about a minute the game is live at `https://<your-username>.github.io/<repo-name>/`.
   Open it on your phone and turn it sideways.

**Full screen:** browsers only allow full screen after a tap, so the game opens on a **Tap to play** screen: that first tap puts the whole game (menu included) in full screen, and any later tap brings it back if you swipe out. On Android you can also tap **Install the app** on the menu; the installed app always opens full screen with no tap needed. iPhones don't let web pages go full screen at all, so on an iPhone tap **Share → Add to Home Screen** and start the game from that icon — it then opens without any browser bars.

Any static host works too (Netlify, Cloudflare Pages, itch.io as an HTML game…).

### Run it on your computer
ES modules don't load from `file://`, so start any static server in this folder:
```
python3 -m http.server 8000
```
then open `http://localhost:8000/?desktop=1` (the `?desktop=1` switch allows mouse + WASD for testing).

---

## 🎮 Controls

| | |
|---|---|
| **Left half of the screen** | Walk joystick (appears under your thumb). Movement is relative to the camera. |
| **Right half of the screen** | Sword joystick. Where you hold it is where the tip points: up = toward the enemy, sides = out to the sides, down = wind-up over the shoulder. Sweep quickly around the edge to slash. Push up past the middle to *thrust* (stab). Let go to return to guard. |
| **⚙** | Settings during a match (pauses bot fights). |
| **✕** | In a match: tap once, then tap again to leave to the main menu. On the main menu: leaves the game. |
| **Main menu** | Tap the sky and your duelist on the pedestal swings in a random direction. |

---

## 🌐 How online play works

There is no game server. The player who **creates** the match (or waits in a public slot) is the **host**. Their phone runs the physics for both fighters. The other phone sends its joysticks 30×/s and receives the positions of every body part 30×/s. Connections are made peer-to-peer (WebRTC) through the free public [PeerJS](https://peerjs.com) matchmaking service.

- **Quick Match** looks for someone waiting in public slots 1–10, otherwise waits in a free slot.
- **Private Match** → *Create a code* gives a 5-letter code; your friend types it under *Join*.
- If either player leaves, the other goes back to the menu.
- Some strict mobile or corporate networks block peer-to-peer. If a match won't connect on mobile data, try Wi-Fi. For 100 % reliability add a TURN server to `ICE_SERVERS` in `js/config.js`.
- **Test online play on one computer:** open `index.html?local=1&desktop=1` in two tabs of the same browser. A fake in-browser network connects them with no internet.

---

## 🧠 How the physics works (honest version)

The game uses its own small rigid-body engine (`js/physics.js`, XPBD with 10 substeps per frame). Nothing is animated: every pose comes from joint motors ("muscles") pulling limbs toward targets.

- **Walking** is a stepping controller. It watches where the body is falling to (the *capture point*) and swings a foot there by inverse kinematics. The standing leg pushes the body along through a force pair between the torso and the planted foot. That means the floor's friction is what moves you: a foot in the air or a slipping foot can't push.
- **Balance** comes from the stance leg: the ankle holds the shin, the knee holds the height, and the hip turns the torso upright *against the leg that is on the floor*. There is also a weak "core strength" torque on the torso. It fades to zero once the body tilts past about 35° and needs a foot on the floor, so big swings, lost legs, hits and collisions really can knock a fighter over. After a fall the fighter gets back up after about 1.3 s, provided at least one leg still works.
- **The sword** is pulled toward the joystick target by the arms' strength (a limited force and torque). The reaction goes into the torso, so hard swings shove your own body around.
- **Cuts** switch off the collision between that blade and that limb and lock the blade into its cutting plane (slash) or along its own axis (stab). Flesh drags on the blade, and depth is measured every frame.

Run the automated checks (standing, swinging, walking in every direction, chaos input, cutting, stabbing, full bot-vs-bot matches):
```
npm test
```

---

## 🛠️ Files

| File | What's in it |
|---|---|
| `js/config.js` | Tunable numbers: walk speed, sword strength, cut thresholds, bleeding, round timings, bot skill curves, network settings |
| `js/physics.js` | XPBD rigid-body engine: bodies, joints with limits and drives, contacts with anchored friction |
| `js/fighter.js` | The 14-part body, stepping/balance controller, sword control, severing, collision rules |
| `js/combat.js` | Slash/stab detection, cut constraints, damage, limb health, bleeding, severing, vital hits |
| `js/match.js` | Rounds, bleed-out rule, draws, first-to-3 |
| `js/bot.js` | Bot AI (levels 1–10) |
| `js/render.js` | three.js scene: sky, clouds, platform, lights and shadows, fighter meshes, swords, blood, camera |
| `js/main.js` | Screens, settings, menu pedestal, bot / host / guest sessions, game loop |
| `js/net.js`, `js/netsync.js` | PeerJS matchmaking, snapshots and the guest-side mirror |
| `js/input.js`, `js/hud.js`, `js/audio.js` | Touch joysticks, HUD, synthesized sounds |
| `tests/` | Headless Node tests (`npm test`) |

Third-party libraries (MIT licensed), bundled in `vendor/`: three.js r170 and PeerJS 1.5.4.

Tip: on a computer, open the console and type `RD.session.match` to inspect a running match.
