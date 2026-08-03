# Windows workaround for the official installed app

The official AIRI **Windows** builds ship an SDK loader bug: extension
entrypoints are imported as plain `C:\...` paths, which Node's default ESM
loader rejects (`ERR_UNSUPPORTED_ESM_URL_SCHEME`). The extension host finds
the plugin, but the entrypoint fails to start — this affects **every**
extension on Windows, not just this one.

This folder contains a launcher-level workaround that does **not modify the
app**:

1. The launcher starts `airi.exe` with `--inspect=9229` (the official build
   leaves the Node inspector open).
2. `airi-loader-injector.mjs` attaches to the inspector and registers an ESM
   `resolve` hook that converts Windows paths to `file://` URLs, so the
   extension entrypoint imports successfully.
3. As a fallback it touches the entrypoint file to trigger the host's
   auto-reload re-import, then exits.

## Setup

1. Copy the extension folder into the installed app's userData:
   `%APPDATA%\ai.moeru.airi\extensions\v1\airi-twitch-chat\`
2. Copy `airi-loader-injector.mjs` to `%APPDATA%\ai.moeru.airi\`
3. Enable the extension: `%APPDATA%\ai.moeru.airi\extensions-v1.json` with
   `"enabled": ["airi-twitch-chat"]` and (optional, for the reload fallback)
   `"autoReload": ["airi-twitch-chat"]`.
4. Edit `AIRI.bat.template` (replace the `<PLACEHOLDER>` paths) and launch
   the app through the bat instead of `airi.exe`.

## Notes

- The app keeps `--inspect=9229` open while running (loopback only) — the
  price of not touching the app.
- Once the upstream SDK loader fix lands in an official release, this
  workaround is no longer needed; the extension folder alone is sufficient.
- The userData folder name (`ai.moeru.airi`) is the installed app's — the
  dev build uses `@proj-airi\stage-tamagotchi` and does not need the
  workaround.
