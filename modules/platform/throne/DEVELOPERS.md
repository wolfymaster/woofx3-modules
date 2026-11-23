# Throne module notes

The module exposes a webhook trigger (`throne_webhook`) handled by
`handle_throne_webhook`. Every request is verified against Throne's signing key
before any event is emitted.

Event ids emitted on the bus:

- `throne.gift.purchased`
- `throne.contribution.purchased`
- `throne.gift.crowdfunded`

Payload fields are documented per trigger in `manifest.json` (`emits.fields`).
Notes that apply to all of them:

- `eventId` is Throne's delivery id; a retried delivery carries the same id.
- `price` and `amount` are integers in hundredths of the currency unit
  (1099 is 10.99). `priceDisplay` and `amountDisplay` are two-decimal strings.
- `currency` is an ISO 4217 code.
- `gifterUsername` is "Anonymous" when the supporter hid their name.
