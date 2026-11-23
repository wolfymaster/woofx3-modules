# Discord: developer notes

- Setting `webhookUrl` holds the Discord webhook URL (a secret).
- Workflows: `go-live-announcement` (trigger `stream.online`, action `discord.announce_go_live`) and `offline-announcement` (trigger `stream.offline`, action `discord.announce_offline`).
- Actions return `ok` and `messageId`; the announce actions also return `skipped` when their setting is off.
- `discord.post_message` takes `ping` of `""`, `here` or `everyone`. Mentions inside message text never ping, so chat text can't notify the whole server.
- Discord rate-limits webhooks; bursts may drop posts.
