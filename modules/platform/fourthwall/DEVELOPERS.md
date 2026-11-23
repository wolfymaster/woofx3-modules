# Fourthwall: developer notes

The `fourthwall_webhook` trigger receives Fourthwall's HTTP deliveries; every request is checked against `webhookSecret` before anything fires. Handler: `handle_fourthwall_webhook`.

## Events

| Event | Extra fields |
|---|---|
| `fourthwall.donation` | none |
| `fourthwall.order.placed` | `itemCount`, `itemNames` (comma separated) |
| `fourthwall.gift.purchased` | `quantity`, `itemName` |
| `fourthwall.subscription.purchased` | `username` (nickname), `interval` (`MONTHLY` or `ANNUAL`); no `message` |

Shared fields: `eventId` (a retried delivery carries the same id), `username` (empty when none), `message`, `amount` (main currency unit), `amountDisplay` (two decimals, no symbol), `currency` (ISO 4217), `isTest`.
