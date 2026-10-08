# Spam Battle

Let chat pick a champion! Spam Battle asks your viewers to spam the name of
their favorite streamer. Every time a name shows up in chat, it gets a vote.
The top names fight it out on screen, head to head, with their share of the
votes climbing live. When the clock hits zero, the winner gets crowned with a
big celebration, and their channel pops up right on your stream.

## What it can do

- **Get chat going.** When a battle starts, your bot tells chat to spam their
  favorite streamer, and what the winner gets, like "5 subs to the winner!"
- **Show a live battle.** The top two face off in a tug of war, and the top
  names race side by side with their percent of the votes. Watch the bars
  jump as chat spams!
- **Make every vote feel big.** Names bounce when they get votes, a "New
  leader!" banner slams in when someone takes first place, and the clock
  flashes red in the last ten seconds.
- **Crown the winner.** When time runs out, the winner's picture and name
  spin in under a crown, with confetti everywhere.
- **Show off the winner's channel.** A few seconds later, the winner's Twitch
  channel loads right in your OBS scene, so you can check them out together.
- **Keep it fair.** Only real streamers count. Everyday chat words like "lol"
  or "gg" don't get on the board.

## Getting started

1. Install the Twitch module first, so Spam Battle can read chat.
2. Install the OBS module and connect it, if you want the winner's channel to
   show up in OBS.
3. Add Spam Battle to a scene. It stays hidden until a battle starts.
4. Type **!spambattle start** in chat. Let the spam begin!

## Running a battle

- **!spambattle start** starts a battle. Add a time to pick how long it
  lasts, like **!spambattle start 2m** or **!spambattle start 90s**. Leave it
  off to use your timer's own length.
- **!spambattle end** stops the clock early and crowns whoever is ahead.
- **!spambattle cancel** calls it off with no winner.
- **!spambattle** lets anyone in chat see who's winning.

Only you and your moderators can start, end or cancel a battle.

Spam Battle makes a timer for you called **Spam Battle**, set to two
minutes. You'll find it with your other timers. Change its length there, or
start it from anywhere you use timers and the battle starts with it. Want to
use a timer you already have? Pick it in the Spam Battle settings instead.

## Make it yours

- Change what your bot says to chat, and the prize.
- Pick how many names show on the board, from two to six.
- Choose how long the winner stays on screen.
- Pick your two battle colors and the size.
- Choose how long the celebration plays before the winner's channel shows up
  in OBS, or turn that part off.

## Good to know

- Chat can vote by typing a name, an @name, or a link to the channel. Spam
  away! Every message counts.
- To start, only Twitch partners and affiliates can win, so random words
  can't sneak on the board. You can turn that off to let any channel win.
- Leave your own channel or your bots out by adding them to the list of names
  that can't be voted for.
- The winner's channel shows up in a browser source called **Spam Battle
  Winner**. It's added to your live scene the first time. After that, the
  same one is reused, so you can move it and resize it however you like.
- When a battle ends, you can make your own alerts happen too, like a sound,
  a light show or a shoutout for the winner.
