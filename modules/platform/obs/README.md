# woofx3_obs

Workflow actions that control OBS:

| Action | What it does |
|---|---|
| `obs.switch_scene` | Makes a scene the live program scene. |
| `obs.set_source_visibility` | Shows or hides a source in a scene, or in the live scene when none is named. |
| `obs.set_input_mute` | Mutes or unmutes an audio input, such as a microphone or desktop audio. |

A step fails, with OBS's reason, when OBS is not connected or has no scene,
source or input by that name. Names are OBS's own, case included, so renaming a
scene in OBS breaks the steps that name it.

## How it reaches OBS

The engine holds the one OBS WebSocket connection (its scene manager), and this
module reaches it through `ctx.obs`. Each action is a function that calls
`ctx.obs`, which asks the engine to act and throws OBS's reason when OBS
refuses:

- `ctx.obs.switchScene({ sceneName })`
- `ctx.obs.setSourceVisibility({ sceneName?, sourceName, visible })`
- `ctx.obs.setInputMute({ inputName, muted })`

The scene, source and input pickers are filled by this module's own
`listScenes`, `listSources` and `listInputs` functions. They call
`ctx.obs.listScenes()` and so on, and are run by the engine's field-options
responder (`barkloader.module.field_options`).

`ctx.obs` needs an engine that provides it (woofx3#167). An older engine rejects
the install because it does not know the `obs.control` permission.

## Permission

The module declares `obs.control`, which lets its functions change OBS: switch
scenes, show and hide sources, and mute or unmute inputs. The engine refuses
those `ctx.obs` calls from a module that does not declare it. Listing OBS's
scenes, sources and inputs needs no permission.

## Connecting OBS

OBS is connected to the engine, not to this module. The engine's
`docs/services/obs.md` covers it: enable the WebSocket server in OBS
(**Tools → WebSocket Server Settings**, OBS 28 or later), then give the engine
its address and password (`WOOFX3_OBS_HOST`, `WOOFX3_OBS_PORT`,
`WOOFX3_OBS_RPC_TOKEN`). The engine reconnects on its own, so OBS can be started
in any order.
