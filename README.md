# Pecking Order

*A game of ranking.*

![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-blue)
![Flask 3](https://img.shields.io/badge/flask-3.x-black)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

Gather a flock of anything (fruits, movies, pizza toppings, restaurants,
songs...), then settle its pecking order by voting on head-to-head matchups.
Two contenders face off, your group picks the one it likes more, and after a
handful of rounds you get a complete, numbered ranking of the whole list.

It's built for a group gathered around one screen, arguing it out. Or turn on
**phone voting**: everyone scans a QR code, votes secretly from their own
phone, and the majority rules. The birds are just for fun: you can rank
anything.

![A matchup in progress](docs/matchup-light.png)

## Contents

- [Quick start](#quick-start)
- [How to play](#how-to-play)
- [Game options](#game-options)
- [Phone voting](#phone-voting)
- [Results and fun stats](#results-and-fun-stats)
- [Saving, resuming and The Nest](#saving-resuming-and-the-nest)
- [Light and dark themes](#light-and-dark-themes)
- [How the ranking works](#how-the-ranking-works)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Quick start

Everything runs on your own computer: no account, no hosting, and nothing
leaves your local network. You only need **Python 3.9 or newer**. There's no
Node, no database server and no build step.

### 1. Get the code

With git:

```bash
git clone https://github.com/shanekdang/pecking-order.git
cd pecking-order
```

Without git: on the GitHub page, click **Code → Download ZIP**, unzip it,
and open a terminal inside the unzipped folder.

### 2. Install the two dependencies (Flask, and segno for QR codes)

```bash
pip install -r requirements.txt
```

<details>
<summary>Optional: install into a virtual environment instead</summary>

A virtual environment keeps these packages out of your global Python install.

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
```

Activate it again each time you open a new terminal to run the app.
</details>

### 3. Run it

```bash
python app.py
```

Then open **http://127.0.0.1:5000** in your browser. To stop the app,
press `Ctrl+C` in the terminal it's running in.

The terminal also prints the address phones can use to join
[phone voting](#phone-voting) games. To keep the app reachable from this
computer only, run `python app.py --local` instead.

On some systems the commands are `python3` and `pip3` instead of `python`
and `pip`.

## How to play

![Setting up a game](docs/setup.png)

### 1. Gather your flock

- **What are we ranking?** Give the game a name, like *Best Pizza Toppings*.
- **Gather your flock.** Add contenders one at a time (type a name and
  press **Enter** or **Add**). To add many at once, click **+ paste a list**
  and paste one name per line. Duplicates are skipped automatically, and
  you can remove anyone with the **✕** next to their name.
- **Short on ideas?** Click **🎁 grab a flock pack** for a ready-made list
  (Halloween candy, pizza toppings, superpowers, dream trips and more). It
  fills in the title too if you haven't typed one. Packs live in
  `static/packs.js` if you want to add your own.
- Pick a **mode**, a **squabble timer** setting and how to **vote** (see
  [Game options](#game-options)).
- Press **Let the Pecking Begin**. The button shows the maximum number of
  matchups your list could take.

You need at least two contenders. Your half-built list is remembered in the
browser, so refreshing the page won't lose it.

### 2. The pecking

Each round shows two contenders side by side: one on the **Robin** card and
one on the **Bluebird** card.

- **Click the card** of whichever contender your group likes more.
- **Birds of a feather — call it a tie** is for genuine dead heats only.
  Even a slight preference is more useful than a tie, so if you lean either
  way at all, pick that side.
- The bird hopping along the branch at the top shows how far through the
  game you are. The counter reads *Peck 7 / up to 17* because the real
  number of matchups is often lower than the maximum.
- **Fly the coop** abandons the game and throws away its progress.

Every vote is saved as soon as it's cast, so you can close the tab
mid-game and pick up later (see
[Saving, resuming and The Nest](#saving-resuming-and-the-nest)).

### 3. The final pecking order

When the last matchup is decided, the results are revealed one place at a
time: the rest of the flock settles in from last place, then third, second,
and after a drumroll, the winner lands on the podium in a burst of confetti.
Press **Skip to the results** if you can't wait.

![The winner is revealed](docs/reveal.png)

Then you get the full ranking, with the winner crowned **Top of the roost**
and the top three marked gold, silver and bronze. Contenders you called a tie share a rank and are labeled **Tie**.
Below the ranking are some [fun stats](#results-and-fun-stats) about how
the game went.

From here you can:

- **Copy as text**: copies a numbered list to your clipboard, ready to
  paste into a group chat.
- **Download as PDF**: opens your browser's print dialog with a clean,
  printer-friendly layout. Choose **Save as PDF** as the printer.
- **🎉 Replay the reveal**: run the dramatic reveal again.
- **🔁 Rematch**: play the same flock again with the same options. When it
  finishes, the results show what changed since last time: who climbed, who
  fell, and which matchups the group decided differently.
- **Gather a New Flock**: go back and start another game.

![The final pecking order](docs/results.png)

## Game options

### Mode

| Mode | What you get | Matchups needed |
|---|---|---|
| **Complete Ranking** | Every contender ranked from 1st to last. | Roughly *n × log₂(n)*. About 25 for 10 contenders, about 70 for 20. |
| **Quick Mode** | Just the **Top 1**, **Top 3** or **Top 5**, in order. Everyone else is left unranked. | About *n − 1* to find 1st place, plus a few more for each extra place. Much faster for long lists. |

Use Quick Mode when you only care who wins: *"Which restaurant are we going to
tonight?"*

### Squabble timer

Every matchup is timed for the fun stats. This setting decides when the
clock starts.

- **Starts Automatically**: the clock starts as soon as the matchup appears.
  Good for quick, gut-feel decisions.
- **Start Manually**: the cards stay locked until you press
  **Let them squawk ▶**. Use this when you need to listen to two songs or
  watch two clips before deciding. The listening time isn't counted, so the
  stats only measure how long the group actually argued.

### Voting

- **One Screen**: the group decides together and clicks the winner.
- **Everyone's Phones**: each person votes on their own phone. See
  [Phone voting](#phone-voting).

## Phone voting

Choose **📱 Everyone's Phones** before starting a game, and the big screen
becomes a lobby with a QR code.

![The lobby, with a QR code to join](docs/phones-lobby.png)

1. **Join.** Everyone scans the code with their phone camera (or types the
   address under it), picks a name and gets their own colored bird. Phones
   must be on the **same Wi-Fi** as the computer running the app.
2. **Start.** Press **Start the pecking** once everyone's in. Latecomers can
   still join mid-game by tapping the small QR code next to the flock.
3. **Vote.** Each matchup appears on the big screen and on every phone. Tap
   your pick; you can change your mind until the vote closes. The big screen
   shows *who* has voted, never *what* they voted.
4. **The reveal.** Once everyone has voted, the ballots land on the cards
   as little birds and the majority wins. The next matchup follows after a
   few seconds, or press **Next matchup** to move on sooner. Press
   **Close the vote now** if you don't want to wait for a straggler.
5. **Deadlocks.** On an exact split, the vote can't decide. Argue it out,
   then the host taps the winner (or the tie button) on the big screen.

| On a phone | On the big screen |
|---|---|
| ![Voting on a phone](docs/phones-vote.png) | ![The reveal](docs/phones-reveal.png) |

6. **The results.** Phones show *"Eyes on the big screen!"* during the
   dramatic reveal, so nobody spoils it, then show the flock's final order.

### Your own pecking order

The flock's order is a compromise. After a phone game, everyone can also
get a ranking by **their own** taste: tap **Rank it my way** on the
results screen. Each vote you cast during the game is filled in
automatically, so you only answer the few matchups your own choices lead
to (often none at all).

Your phone then has a **Mine / The flock** toggle. Your list shows where the
flock put each contender, so your hot takes stand out. **Download as an
image** saves a picture of both lists side by side, and **Copy as text**
copies both for a group chat. The big screen shows everyone's own top five
and how many spots each person matched the flock on, as people finish.

![Your own order next to the flock's](docs/phones-own-order.png)

Good to know:

- If nobody joins from a phone, the host can still tap the cards directly.
- Phones remember their name, so a refresh (or restarting the app) puts
  them straight back in. Players stay joined between games, so the same
  group can play again without rescanning.
- A phone that closes the page stops counting as "here" after about 45
  seconds, so it won't hold up the vote.
- With the **Start Manually** squabble timer, phones stay locked until the
  host presses **Let them squawk ▶**.
- Phones can only reach the voting page. Setting up games, The Nest and
  deleting games only work from the computer running the app.

## Results and fun stats

The stats never affect the ranking. They just tell the story of the game.

| Stat | What it means |
|---|---|
| **Total deliberation / squabble time** | Time spent deciding, added up across every matchup. |
| **Hot streak** | The contender (or contenders) that won the most matchups in a row. Shown for streaks of 2 or more. |
| **Most contested** | The contender that showed up in the most matchups. |
| **Birds of a feather** | How many matchups were called a tie. |
| **Biggest squabbles** | The matchups that took longest to decide. |
| **Easiest calls** | The matchups that were decided fastest. |

Phone-voting games also show each matchup's split (like *3–1*) and these
stats about the voters:

| Stat | What it means |
|---|---|
| **Voice of the flock** | Who sided with the majority most often. |
| **Odd bird out** | Who sided with the majority least often. |
| **Two of a feather** | The two people who voted alike most often (with 3 or more voters). |
| **Unanimous calls** | Matchups where everyone voted the same way. |
| **Deadlocks the host broke** | Exact splits the host had to decide. |
| **Fence sitter** | Whoever voted "tie" the most (2 or more times). |
| **Who sided with the flock** | Everyone's agreement with the majority, from most to least. |

Each phone also gets its own result at the end: *You sided with the flock 7
of 9 times.*

After a **rematch**, the results also list every contender's move since last
time (▲ climbed, ▼ fell) and each matchup the group decided differently,
like *Olives vs Pepperoni: Pepperoni → Olives*.

With the automatic timer, the clock keeps running until someone votes, so
a snack break mid-matchup can show up in *Biggest squabbles*.

## Saving, resuming and The Nest

- **Resuming a game:** progress is saved after every vote. If you close the
  tab or stop the app mid-game, the start screen offers a **Resume** banner
  next time. Choose **Discard** instead to throw that game away. If you
  start a new game without finishing the old one, the banner offers the
  newest unfinished game.
- **The Nest** (🪺 button in the top right) lists every finished game, newest
  first. Click one to see its full results and stats again (or start a
  **Rematch** of it), or click **✕** to delete it.
- **Where the data lives:** everything is stored in a single SQLite file
  at `data/tournaments.db`, created automatically the first time you run
  the app. It's ignored by git, so your games stay on your machine.

## Light and dark themes

Click the 🌙 / ☀️ button in the top right to switch between a sunny daytime
sky and a starry night. By default the app follows your computer's light or
dark setting. Once you click the button, your choice is remembered in that
browser.

| Light | Dark |
|---|---|
| ![Light theme](docs/matchup-light.png) | ![Dark theme](docs/matchup-dark.png) |

## How the ranking works

A single-elimination bracket only finds one winner. A full round-robin,
where everyone faces everyone, needs *n × (n − 1) / 2* matchups, which is 190
for a list of 20.

**Complete Ranking** instead runs a **merge sort** in which your group plays
the part of the comparison function. Contenders start as solo "flocks" that
are merged two at a time. Each merge asks you to compare only the front
contender of each flock, so the app never asks about a pair whose order
already follows from earlier answers. The result is a full ranking in
roughly *n × log₂(n)* matchups.

**Quick Mode** starts with a knockout round. Each matchup eliminates its
loser, so crowning 1st place always takes exactly *n − 1* matchups. To find
2nd place, only contenders who lost *directly to the winner* are still in
the running; anyone else lost to someone who wasn't 1st. That small group
plays a mini-knockout, and the same trick repeats for each further place.

**Ties:** a tie places both contenders next to each other in the order, and
if they end up adjacent in the final ranking they share a rank (1, 2, 2, 4…).

## Project layout

```
app.py                Flask routes and JSON API (host and phone)
room.py               Phone voting: live players, ballots and the vote
                      for the game in progress (kept in memory)
lan.py                Finds this computer's Wi-Fi address; draws the join QR
personal.py           Each phone voter's own ranking, prefilled from their votes
tournament.py         Ranking engines (Tournament and QuickTournament);
                      plain Python with no web code, easy to test on its own
stats.py              Fun stats from the vote log, and rematch comparisons
storage.py            SQLite persistence (creates and migrates the database)
templates/index.html  The host page
templates/play.html   The phone page for phone voting
templates/_bird.html  The inline SVG bird used throughout, shared by both
static/app.js         Host frontend logic (talks to the API with fetch)
static/play.js        Phone frontend logic
static/packs.js       The flock packs (ready-made lists)
static/confetti.js    The confetti burst, shared by both pages
static/style.css      Styling, light/dark theme colors and animations
static/favicon.svg    Browser tab icon
docs/                 Screenshots used in this README
data/                 SQLite database (created on first run, gitignored)
```

## Troubleshooting

- **`python` or `pip` isn't found:** make sure Python 3.9+ is installed and
  on your `PATH` (`python --version` should work). Try `python3` / `pip3`
  instead.
- **Port 5000 is already in use:** another program is using it (on macOS
  it's often AirPlay Receiver). Stop that program, or run the app on another
  port with `python app.py --port 5050` and open that port instead.
- **Phones can't connect:** check they're on the same Wi-Fi network as the
  computer (not mobile data or a guest network, which often blocks devices
  from seeing each other). On Windows, the first run may ask whether to let
  Python through the firewall: allow it on **private** networks. If you
  dismissed that prompt, allow Python in *Windows Security → Firewall &
  network protection → Allow an app through firewall*. On macOS, allow
  incoming connections for Python when asked.
- **Working on the code:** `python app.py --debug` turns on Flask's
  auto-reload and debugger. It also implies `--local`, so the debugger is
  never reachable from other devices.
- **The page looks unstyled or out of date after an update:** do a hard
  refresh (`Ctrl+Shift+R`, or `Cmd+Shift+R` on macOS) to bypass the
  browser cache.
- **Fonts look plain:** the Fredoka and Nunito fonts load from Google Fonts.
  Without an internet connection the app still works, but uses your system
  font.
- **Starting over with a clean slate:** stop the app, delete
  `data/tournaments.db`, and start it again. A fresh, empty database is
  created automatically.

## License

[MIT](LICENSE). Do whatever you'd like with it.
