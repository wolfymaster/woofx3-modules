# Govee: developer notes

- Actions: `govee.set_power` (`device`, `on`), `govee.set_color` (`device`, `color`), `govee.set_brightness` (`device`, `brightness` 1-100). Each returns `ok`; a change Govee refuses fails the step with the reason.
- The `device` select loads its options from the `listDevices` function through `barkloader.module.field_options`.
- Uses the Govee cloud API with the `apiKey` setting.
