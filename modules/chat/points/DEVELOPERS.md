# Loyalty Points: developer notes

Commands are read from `user.message` events by the module's own workflow instead of being registered as commands, because only a chat message says whether the sender is a moderator.

## Events

`points.changed` fires on every balance change.

| Field | Meaning |
|---|---|
| `user` | The viewer's name |
| `points` | Balance after the change |
| `delta` | Change applied (negative for a loss) |
| `reason` | `chat`, `gamble`, `give`, `gift from <name>`, `refund`, `carried over`, `added by mod`, `removed by mod`, or a workflow's own reason |

## Actions

- `points.give` takes `user` (name or Twitch user id), `amount` (negative removes) and an optional `reason`. `delta` in the result is smaller than asked when a removal hit 0.
- `points.get` takes `user` and returns `points`.
