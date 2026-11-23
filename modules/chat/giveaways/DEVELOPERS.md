# Giveaways: developer notes

Mod commands and entries are read from `user.message` events by the module's own workflow, because only a chat message carries the chatter's badges.

## Events

| Event | Fields |
|---|---|
| `giveaways.started` | `keyword`, `prize`, `startedBy` (empty when a workflow started it) |
| `giveaways.entered` | `userName`, `userId`, `entryCount` |
| `giveaways.winner` | `winnerName`, `winnerId`, `prize`, `entryCount` |

`handle_chat_message` returns `handled`: one of `none`, `entered`, `started`, `drawn`, `ended`, `cancelled`, `status`.
