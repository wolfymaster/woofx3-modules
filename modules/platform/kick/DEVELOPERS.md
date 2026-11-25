# Kick module notes

Triggers are the platform-neutral woofx3 events the connectors Kick adapter
publishes from Kick webhooks, each declared with `"platform": "kick"` so they
fire only for events stamped `platform: kick`. The adapter's mapping is in
`connectors/src/adapters/kick/lib/events.ts` in the woofx3 repo.
Kick event reference: https://docs.kick.com/events/event-types

| Trigger id | Event | Kick event |
|---|---|---|
| `channel_follow` | `channel.follow` | `channel.followed` |
| `user_message` | `user.message` | `chat.message.sent` |
| `channel_subscribe` | `channel.subscribe` | `channel.subscription.new`, and one per giftee of `channel.subscription.gifts` |
| `channel_subscription_gift` | `channel.subscriptionGift` | `channel.subscription.gifts` with two or more giftees |
| `channel_resub` | `channel.resub` | `channel.subscription.renewal` |
| `stream_online` | `stream.online` | `livestream.status.updated` with `is_live` true |
| `stream_offline` | `stream.offline` | `livestream.status.updated` with `is_live` false |
| `channelpoints_redeem` | `channelpoints.redeem` | `channel.reward.redemption.updated`, first sighting while pending or accepted |
| `kicks_gifted` | `channel.kicks` | `kicks.gifted` |

Notes:

- Kick has one subscription level; `tier` is always `1000`.
- Chat lines carry no follower or tier; `membership.isVip` comes from a `vip`
  badge type, which Kick's docs do not list.
- `channel_resub.cumulativeMonths` is Kick's `duration`; resubs carry no message,
  streak or Prime flag.
- Functions call `ctx.kick` (`getUser`, `updateStream`, `timeout`,
  `listRewards`). `timeout` needs `kick.moderation`, `updateStream`
  `kick.channel`. Timeouts round up to whole minutes; the result's
  `durationSeconds` is what was applied.
- The reward picker reads `kickapi` `listRewards`.
- Chat sending is the core `chat.reply` step through the platform gateway, so
  this module ships no chat function.
