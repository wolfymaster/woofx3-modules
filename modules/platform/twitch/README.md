# woofx3_twitch

Declares Twitch EventSub subscription types as eventbus workflow triggers.

Events are **platform-agnostic**: a trigger's `event` is the NATS subject and
CloudEvent type the engine subscribes to, and it names only what happened —
`channel.follow`, `stream.online`. Which platform it came from travels as the
CloudEvent's top-level `platform` attribute, so a workflow can take follows
from anywhere and narrow to Twitch only when it needs to.

A trigger's `id` is a stable manifest-local identifier (`channel_follow`) and
is deliberately *not* the event. The two were the same value before, which
meant renaming an event also changed the trigger's canonical id and broke
every `$ref` pointing at it.

Each trigger carries two independent `taxonomy` axes:

- `platform.twitch` — where it comes from.
- `alert.*` — what kind of thing happened, for grouping in the alerts UI.
  Eleven groups across 27 triggers, so "a subscription happened" is one entry
  rather than the separate events that make it up.

Shared-chat triggers carry `alert.shared.*` mirroring their own-channel
counterpart (`alert.shared.subscription`, `alert.shared.raid`,
`alert.shared.chat`), which collects them under one Shared group instead of
doubling every group with an entry for someone else's channel. The mirror is
one-to-one: the shared side never nests deeper than the side it mirrors.

The three ad-break triggers carry `stream.ads` in place of an `alert.*` group:
an ad break is the stream's schedule, not something a viewer did. Two of them
are not EventSub topics. `channel.ad_break.upcoming` is published by the engine
from the ad schedule ahead of a scheduled ad, and `channel.ad_break.end` by the
twitch service when a break is due to end, because Twitch sends neither. All
three need the `channel:read:ads` scope; without it they never fire.

Source list: [EventSub subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/).
Extend `manifest.json` when Twitch adds types, and add the matching member to
the engine's `EventType` enum — the two must agree or the trigger subscribes
to a subject nothing publishes.

## Actions

Workflow steps that act on Twitch. Each is a manifest action backed by a
function in `functions/` that calls the engine's `ctx.twitch` capability and
hands the twitch service's answer back as the step's output, so a later step
can read it as `${stepId.field}`. Workflows reference them by canonical id,
`woofx3_twitch:action:<id>`.

| Action | Does | Inputs | Outputs |
|---|---|---|---|
| `twitch.chat.send` | Sends a chat message as the bot | `message` | none |
| `twitch.shoutout` | Twitch's own shoutout of another channel | `user` (name or id), `skipIfRateLimited` | `userId`, `skipped` |
| `twitch.clip` | Clips the live stream | none | `id`, `url` |
| `twitch.marker` | Places a stream marker | `description` (optional) | `id`, `createdAt`, `description`, `positionSeconds` |
| `twitch.update_stream` | Changes the title, category or tags | `title`, `category`, `tags` (comma-separated), each optional | `title`, `categoryId`, `categoryName`, `tags` (the ones changed) |
| `twitch.timeout` | Times a chatter out | `user` (name or id), `durationSeconds` (default 600), `reason` (optional) | `userId`, `durationSeconds` |

A `user` that is all digits is used as a Twitch user id; anything else is a
login name (a leading `@` is dropped) that the engine resolves. That lets a raid
or chat trigger pass its user id straight through, and a chat command pass
whatever was typed.

The functions only check that inputs are present and of the right type. The
twitch service owns Twitch's rules (title and tag lengths, timeout range, how a
category name resolves), so they live in one place and its error reaches the
workflow unchanged. When Twitch refuses, the step fails with that message.
`twitch.shoutout` can instead succeed with `skipped: true` when the refusal is
Twitch's shoutout rate limit (one every 2 minutes), which back-to-back raids
hit often.

`twitch.update_stream` leaves a blank field unchanged, so a step can set only
the title. `category` is free text: an exact name match wins, otherwise the most
relevant Twitch search result. `tags` replaces all of the stream's tags.

### Permissions

The manifest requests two engine permissions:

```json
"permissions": ["twitch.moderation", "twitch.channel"]
```

| Permission | Needed by | Why it is gated |
|---|---|---|
| `twitch.moderation` | `twitch.timeout` (`ctx.twitch.timeout`) | It acts on the channel's chatters. |
| `twitch.channel` | `twitch.update_stream` (`ctx.twitch.updateStream`) | It changes what viewers see about the stream. |

Clips, markers and shoutouts need none. The engine refuses an undeclared
privileged call before anything reaches Twitch, and a declared permission is
what the streamer sees the module ask for at install.

### Engine requirements

These actions need an engine whose `ctx.twitch` calls return the twitch
service's result and that understands manifest `permissions`. On an older
engine the manifest still installs (the unknown `permissions` field is
ignored), but the actions fail with a clear error instead of silently doing
nothing: `twitch.marker` because `ctx.twitch.createMarker` does not exist, the
others because their call returns no result. The Twitch account linked to the
engine needs the `clips:edit`, `channel:manage:broadcast`,
`moderator:manage:shoutouts` and `moderator:manage:banned_users` scopes.
