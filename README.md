# airi-twitch-chat

Connect [AIRI](https://github.com/moeru-ai/airi) to Twitch chat: the character
reads chat messages, replies to them, and you get a small in-app widget to
manage the connection.

Self-contained, zero dependencies, no build step — drop the folder into
AIRI's `extensions/v1` and enable it.

## Features

- **Chat → character**: Twitch chat messages are forwarded into the
  character's chat session (via the local AIRI channel server), so the
  character sees `[Twitch] viewer: message` as input.
- **Character → chat**: the character's reply is automatically posted back to
  the Twitch channel (debounced to the final reply, one per message).
- **Config widget**: a gamelet widget (auto-opens at startup) with manual
  **Connect** / **Disconnect** buttons, an **Auto-reply to chat** toggle, a
  masked token field, live connection status, a **chat log** showing every
  received message and posted reply, and a **warning banner** when the
  character doesn't answer (e.g. no chat model selected in AIRI).
- **Character tools**: `twitch-send-message`, `twitch-get-messages`,
  `twitch-status`, `twitch-open-config` (plus a toolset prompt teaching the
  character to use them).
- **Safety**: bot's own messages are filtered (no reply loops), duplicate IRC
  deliveries are deduplicated, a configurable cooldown (default 5s) paces
  triggers, messages are truncated to Twitch's 500-character limit and
  rate-limited (~20 msgs / 30s), and credentials never leave your machine —
  the extension is fully local (loopback HTTP server + your own IRC
  connection).

## Install

1. Copy the whole folder into AIRI's extensions directory:
   `%APPDATA%\@proj-airi\stage-tamagotchi\extensions\v1\airi-twitch-chat\`
   (for the installed desktop app the user-data folder may differ — see
   below).
2. Create `config.json` next to `index.mjs` (copy `config.example.json`):

   ```json
   {
     "username": "your_twitch_username",
     "oauth": "oauth:your_chat_token",
     "channels": ["#your_channel"]
   }
   ```

   Get a chat token at <https://twitchtokengenerator.com> (scopes
   `chat:edit`, `chat:read`, `user:read:chat`). The token only grants chat
   read/write — never share it, and never commit `config.json` to git.
3. Enable the extension: create
   `%APPDATA%\@proj-airi\stage-tamagotchi\extensions-v1.json` with
   `"enabled": ["airi-twitch-chat"]`, then restart AIRI.
4. The config widget opens automatically. Press **Connect** — the status dot
   turns green when joined. Send a message in your channel; the character
   replies and the reply is posted to chat.

### Requirements

- AIRI with the extension host (`extensions/v1`, manifest v1,
  `toolKit`/`gameletKit`). At the time of writing that is the `main` branch /
  0.11.3+ era source.
- **Windows caveat**: the official Windows builds currently ship an SDK
  loader bug (`ERR_UNSUPPORTED_ESM_URL_SCHEME` when importing extension
  entrypoints) that prevents *any* extension from starting — see
  `windows-workaround/` for a launcher that fixes it without modifying the
  app. Linux/macOS builds and dev builds are unaffected.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `username` | — | Twitch account that sends the messages |
| `oauth` | — | Chat token (`oauth:…`) |
| `channels` | — | Channels to join, with or without `#` |
| `autoReply` | `true` | Forward chat to the character and auto-post replies |
| `replyCooldownMs` | `5000` | Minimum time between forwards (configurable in the widget, in seconds) |

All fields can be edited in the widget (the token field only reports whether
one is already saved — it is never sent back to the page).

## How it works

- The extension connects to Twitch IRC over WebSocket and joins your channels.
- Messages are buffered (100/channel) and forwarded to the character as
  `input:text` events on AIRI's local channel server (`ws://127.0.0.1:6121`),
  targeted at the character window (the widgets window is excluded to avoid
  double responses).
- The character's reply is captured from the `output:gen-ai:chat:complete`
  events and auto-posted to the first configured channel.
- The widget is served by a loopback HTTP server the extension owns
  (`127.0.0.1`, random port) and reads/writes `config.json`; saving new
  credentials disconnects first, and **Connect** applies them.

## Troubleshooting

- **"Not configured"** in the widget: `config.json` is missing or the token
  is the placeholder — save via the widget.
- **Reconnect loop**: the extension reconnects with backoff on drops; the
  loop can only persist if a stale socket keeps re-entering `connect()` — the
  current code guards against that (only the current socket may schedule a
  reconnect). If you see a tight loop, check the log for the close code.
- **Messages arrive but no reply**: make sure the character has an active
  provider + model (Settings → character model), and that Auto-reply is on.
  The widget shows a warning banner when a forwarded message gets no reply
  within 45s — that almost always means no model is selected.
- **No extension at all on Windows official builds**: apply
  `windows-workaround/`.

## License

MIT — see [LICENSE](LICENSE).
