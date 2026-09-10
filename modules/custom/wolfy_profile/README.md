# wolfy_profile

Example module packaging workflow definitions that used to be pushed via `woofx3/wooflow/workflows/*.sh` (POST to `/v1/workflow-definitions`).

This module declares **only workflows** — no triggers, actions, or functions of its own.

- Workflows bind to **event types** (`channel.follow`, `channel.cheer`, ...), not to another module's trigger declarations. Nothing has to be installed first, and whichever module emits the event — at whatever version — satisfies the binding. The Twitch module can be uninstalled and reinstalled underneath these workflows without touching them.
- **`woofx3:action:alert`** — the alert action, declared by the bundled `woofx3` module and installed by barkloader before any upload. This is a hard reference by canonical id, so it is checked at install like any other cross-module reference — there is no longer an exempt namespace.

The legacy `update_timer` step on the follow workflow has been dropped pending a built-in (or `slobs` module) that exposes a timer action; the rest of the alert behavior is preserved.

## Source mapping

| Workflow `id` | Source script |
|---------------|----------------|
| `follow-workflow` | `wooflow/workflows/follow_workflow.sh` |
| `subscription-workflow` | `wooflow/workflows/subscription_workflow.sh` |
| `bits-workflow` | `wooflow/workflows/bits_workflow.sh` |
| `gifted-subscription-workflow` | `wooflow/workflows/giftedSubscription_workflow.sh` |

Scripts `simple_workflow.sh` and `add_workflow.sh` still live under `wooflow/workflows/` but are not included in this manifest.

## Workflow triggers

Every `workflow.trigger` is a bare event type — the NATS subject and CloudEvent
type the engine subscribes to:

| Workflow | `trigger` (event type) |
|----------|------------------------|
| `follow-workflow` | `channel.follow` |
| `subscription-workflow` | `channel.subscribe` |
| `bits-workflow` | `channel.cheer` |
| `gifted-subscription-workflow` | `channel.subscriptionGift` |

A `trigger` naming a canonical id (`{moduleId}:trigger:{manifest_id}`) is still
valid and means something different: a hard dependency on that declaration,
which blocks uninstalling the module that provides it. Use it when a workflow
genuinely cannot work without one specific module. These four do not — any
platform's follow will do.

Events carry the originating platform as the CloudEvent's `platform` attribute,
so a workflow that wants Twitch follows only can filter on `${trigger.platform}`
rather than by subscribing to a Twitch-specific subject.

## Trigger conditions (TODO)

The legacy API stored event filters on the trigger. Re-apply these when the manifest gains support for trigger conditions (`ManifestWorkflow.trigger` is currently a string-only reference; condition wiring is tracked separately):

| Workflow | Condition |
|----------|-----------|
| `bits-workflow` | `data.amount >= 1` |
| `user-generated-workflow-1` _(script-only, not packaged here)_ | `data.amount >= 500` |
| `bits-subs-celebration` _(script-only, not packaged here)_ | `data.amount >= 100` |

Other packaged workflows have no conditions.

## Step shape

Every step in this manifest follows the workflow engine's [`TaskDefinition`](../../../../docs/workflow/schema.md#taskdefinition) shape:

```json
{
  "id": "alert",
  "type": "action",
  "action": "slobs:action:media_alert",
  "parameters": {
    "audioUrl": "...",
    "mediaUrl": "...",
    "text": "..."
  }
}
```

Notes on the migration from the legacy script format:

- Old step-level `params` is now `parameters` to match the engine's `TaskDefinition`.
- Old `_stepId` field inside params became the step's top-level `id`.
- Old `_stepType` field (`"action"` / `"wait"`) became the step's top-level `type`. Today every step in this manifest is `type: "action"`; `wait` and other types from the legacy scripts will surface here once the manifest gains support for them.
- Old `_stepName` had no equivalent in the engine's task shape and was dropped.
- The legacy `action` string (e.g. `"media_alert"`) is now a full canonical id (`"slobs:action:media_alert"`) referencing an action declared in another module. Action references must be either a manifest-local id (resolved against this manifest's `actions[]`) or a full canonical id with `:` separators — bare strings without canonical form will fail validation.
- `dependsOn`, `exports`, and other engine task fields can be added at the step's top level when needed; they're no longer hidden inside `params`.

## Layout

Unpacked directory for local inspection or tooling. Zip this folder (with `manifest.json` at the archive root) to install through barkloader's upload path. Install order does not matter: these workflows bind to event types, so they install cleanly whether or not anything emitting those events is present yet.
