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
  Ten groups across 24 events, so "a subscription happened" is one entry
  rather than the ten separate events that make it up.

Source list: [EventSub subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/).
Extend `manifest.json` when Twitch adds types, and add the matching member to
the engine's `EventType` enum — the two must agree or the trigger subscribes
to a subject nothing publishes.
