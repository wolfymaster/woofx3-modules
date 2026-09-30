# Discord

Bring your community to your stream! This module tells your Discord server the
moment you go live, so your friends and fans never miss a stream. You can also
post to Discord whenever something big happens on your stream.

## What it can do

- **Announce when you go live.** A post goes up in your Discord with a link
  straight to your stream. It happens on its own every time you start.
- **Ping everyone, if you want.** Turn it on and the whole server gets a
  notification when you go live.
- **Say thanks when you're done.** Post a friendly thank-you when your stream
  ends. This one is off until you turn it on.
- **Post anything, anytime.** Send a message to Discord whenever something
  happens on stream. You can add a colourful card with a title and a link.

## Ideas to try

- When someone raids, post a thank-you in Discord with a link to their channel.
- When you hit a big sub goal, share the news with your whole server.
- When you make a clip, drop it in your clips channel.
- Write your own go-live message so it sounds just like you.

## Getting started

1. Open Discord and go to your server.
2. Open **Server Settings**, then **Integrations**, then **Webhooks**.
3. Click **New Webhook**. Pick the channel you want posts to go in, like
   #going-live.
4. Click **Copy Webhook URL**.
5. Paste it into this module's **Discord webhook URL** setting.

That's it! Your next stream will be announced.

## Make it yours

In the module settings you can:

- Change the go-live message. Use {channel} for your channel name and {link}
  for a link to your stream.
- Turn the @everyone ping on or off.
- Turn the end-of-stream thank-you on or off, and change what it says.
- Set your own stream link, if you want {link} to go somewhere else.

## Good to know

- Only you choose when to ping @everyone or @here. If a chatter's message has
  "@everyone" in it, it won't ping your server.
- Keep your webhook link private. Anyone who has it can post in that channel.
  If it leaks, delete the webhook in Discord and make a new one.
- Discord only lets a webhook post so fast. If lots of posts happen at once,
  some may be skipped.
