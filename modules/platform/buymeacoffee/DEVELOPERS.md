# Buy Me a Coffee: developer notes

The `bmc_webhook` trigger receives Buy Me a Coffee's HTTP deliveries; every request is checked against `signingSecret` before anything fires. Handler: `handle_bmc_webhook`.

## Events

| Event | Extra fields |
|---|---|
| `buymeacoffee.donation` | `coffeeCount` |
| `buymeacoffee.membership.started` | `levelName`, `interval` (`month` or `year`) |
| `buymeacoffee.membership.cancelled` | `supporterName`, `levelName`, `isTest`, `eventId` only |

Shared fields: `eventId`, `supporterName`, `message` (empty when none or hidden), `amount` (main currency unit, 15 is 15.00), `amountDisplay` (two decimals, no symbol), `currency` (ISO 4217), `isTest`.
