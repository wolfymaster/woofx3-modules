# Twitch module notes

Triggers are Twitch EventSub subscription types published on the bus. Each
trigger's `event` is the bus subject; the shared constants live in
`shared/common/typescript/cloudevents/Twitch/events.ts` (`EventType`).
EventSub reference: https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/

Payload fields for each trigger are in `manifest.json` under `emits.fields`,
with sample payloads in `examplePayload`.

Notes:

- Events marked `chat.notification` arrive on Twitch's `channel.chat.notification`
  subscription and are split by notice type.
- The `*_shared_*` triggers fire for activity in another participant's channel
  during a Shared Chat session; `sourceBroadcasterId` names that channel.
- Gift subs are reported twice by design: each recipient on the subscribe
  trigger and the whole bundle on the gift trigger. Total one or the other.
- `channel_ad_break_upcoming` is published by the engine from the ad schedule at
  the configured lead time. `channel_ad_break_end` is timed by the engine from
  the start event, since Twitch sends no end event.
- Action inputs accept a login name or a numeric user id; a leading `@` and
  extra spaces are stripped. Template substitution from the trigger event is
  supported in text inputs.
- Shoutouts go through the dashboard shoutout queue (Twitch allows one per 2
  minutes). `skipIfRateLimited` only applies when a shoutout is sent
  immediately because no queue is available.

| Trigger id | Event | Source |
|---|---|---|
| `channel_follow` | `channel.follow` | Twitch EventSub: channel.follow |
| `user_message` | `user.message` | Twitch EventSub: channel.chat.message |
| `channel_subscribe` | `channel.subscribe` | Twitch EventSub: channel.subscribe |
| `channel_shared_subscribe` | `channel.sharedSubscribe` | Twitch EventSub: channel.chat.notification (shared_chat_sub, shared_chat_sub_gift) — fires when the sub happens in another participant's channel during a shared chat session. sourceBroadcasterId names that channel. |
| `channel_subscription_gift` | `channel.subscriptionGift` | Twitch EventSub: channel.subscription.gift |
| `channel_shared_subscription_gift` | `channel.sharedSubscriptionGift` | Twitch EventSub: channel.chat.notification (shared_chat_community_sub_gift) — fires when the gift happens in another participant's channel during a shared chat session. sourceBroadcasterId names that channel. |
| `channel_cheer` | `channel.cheer` | Twitch EventSub: channel.cheer |
| `channel_hypetrain` | `channel.hypetrain` | Twitch EventSub: channel.hype_train.begin |
| `stream_online` | `stream.online` | Twitch EventSub: stream.online |
| `channelpoints_redeem` | `channelpoints.redeem` | Twitch EventSub: channel.channel_points_custom_reward_redemption.add |
| `stream_offline` | `stream.offline` | Twitch EventSub: stream.offline |
| `channel_raid` | `channel.raid` | Twitch EventSub: channel.raid |
| `channel_shared_raid` | `channel.sharedRaid` | Twitch EventSub: channel.chat.notification (shared_chat_raid) — fires when the raid happens in another participant's channel during a shared chat session. sourceBroadcasterId names that channel. |
| `channel_resub` | `channel.resub` | Twitch EventSub: channel.chat.notification (resub) |
| `channel_shared_resub` | `channel.sharedResub` | Twitch EventSub: channel.chat.notification (shared_chat_resub) — fires when the resub is announced in another broadcaster's chat during a shared chat session. |
| `channel_gift_paid_upgrade` | `channel.giftPaidUpgrade` | Twitch EventSub: channel.chat.notification (gift_paid_upgrade) — a user upgraded their gifted sub to a paid one. |
| `channel_shared_gift_paid_upgrade` | `channel.sharedGiftPaidUpgrade` | Twitch EventSub: channel.chat.notification (shared_chat_gift_paid_upgrade) |
| `channel_prime_paid_upgrade` | `channel.primePaidUpgrade` | Twitch EventSub: channel.chat.notification (prime_paid_upgrade) — a user upgraded their Prime sub to a paid one. |
| `channel_shared_prime_paid_upgrade` | `channel.sharedPrimePaidUpgrade` | Twitch EventSub: channel.chat.notification (shared_chat_prime_paid_upgrade) |
| `channel_unraid` | `channel.unraid` | Twitch EventSub: channel.chat.notification (unraid) — the broadcaster cancelled an outgoing raid. |
| `channel_pay_it_forward` | `channel.payItForward` | Twitch EventSub: channel.chat.notification (pay_it_forward) — a recipient of a gifted sub paid it forward by gifting another sub. |
| `channel_shared_pay_it_forward` | `channel.sharedPayItForward` | Twitch EventSub: channel.chat.notification (shared_chat_pay_it_forward) |
| `channel_announcement` | `channel.announcement` | Twitch EventSub: channel.chat.notification (announcement) |
| `channel_shared_announcement` | `channel.sharedAnnouncement` | Twitch EventSub: channel.chat.notification (shared_chat_announcement) |
| `channel_charity_donation` | `channel.charityDonation` | Twitch EventSub: channel.chat.notification (charity_donation) |
| `channel_bits_badge_tier` | `channel.bitsBadgeTier` | Twitch EventSub: channel.chat.notification (bits_badge_tier) |
| `channel_watch_streak` | `channel.watchStreak` | Twitch EventSub: channel.chat.notification (watch_streak) |
| `channel_ad_break_upcoming` | `channel.ad_break.upcoming` | An ad break is scheduled soon. Published by the engine from the ad schedule, at the configured lead times. |
| `channel_ad_break_begin` | `channel.ad_break.begin` | Twitch EventSub: channel.ad_break.begin |
| `channel_ad_break_end` | `channel.ad_break.end` | Published when an ad break is due to end. Twitch sends no end event; the engine times it from the start event. |
