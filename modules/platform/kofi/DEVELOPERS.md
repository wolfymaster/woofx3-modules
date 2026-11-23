# Ko-fi: developer notes

The `kofi_webhook` trigger receives Ko-fi's HTTP deliveries; every request is checked against `verificationToken` before anything fires. Handler: `handle_kofi_webhook`.

## Events

| Event | Extra fields |
|---|---|
| `kofi.donation` | none |
| `kofi.subscription` | `tierName` (empty for a plain monthly tip), `isFirstPayment` (false on renewal) |
| `kofi.shop_order` | `itemCount` |
| `kofi.commission` | none |

Shared fields: `messageId` (a retried delivery carries the same id), `fromName` ("Anonymous" when private), `message` (empty when none or private), `isPublic`, `amount` (main currency unit), `amountDisplay` (two decimals, no symbol), `currency` (ISO 4217), `url`.
