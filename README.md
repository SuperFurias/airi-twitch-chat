# airi-twitch-chat

Connects [AIRI](https://github.com/moeru-ai/airi) to Twitch chat: the
character reads chat messages, replies to them, and a small in-app widget
manages the connection.

> ## ⚠️ READ THIS FIRST — it works only if you follow every step
>
> This is **not** a "download and drop into a folder" extension. If you skip
> a step it will silently not work.
>
> **On Windows with the official installed AIRI build, the extension cannot
> start at all without the launcher fix** — an app bug breaks every
> extension, not just this one. The launcher is **mandatory**, not optional.
>
> | Your setup | What you need |
> | --- | --- |
> | Windows, official installed app | **Launcher required** (step 1 below). Without it the extension never starts. |
> | Linux / macOS, official app | No launcher. Steps 2–6 only. |
> | Dev build (`stage-tamagotchi`) | No launcher. Steps 2–6 only. |
>
> Follow the [Install](#install) section **in order**, every step.

## Features

- **Chat → character**: Twitch chat messages are forwarded into the
  character's chat session (via the local AIRI channel server), so the
  character sees `[Twitch] viewer: message` as input.
- **Character → chat**: the character's reply is automatically posted back to
  the Twitch channel (debounced to the final reply, one per message).
- **Config widget**: a gamelet widget (auto-opens at startup) with manual
  **Connect** / **Disconnect** buttons, an **Auto-reply to chat** toggle, a
  masked token field, live connection status, a **chat log** showing every
  received message and posted reply, a **warning banner** when the character
  doesn't answer (e.g. no chat model selected in AIRI), and a **Clear chat
  history** button (with a confirmation dialog) that starts a fresh
  conversation so prompt edits take effect immediately.
- **Character tools**: `twitch-send-message`, `twitch-get-messages`,
  `twitch-status`, `twitch-open-config` (plus a toolset prompt teaching the
  character to use them).
- **Model-driven selection**: the character receives every chat message and
  decides itself which ones deserve an answer (it may decline with `SKIP`,
  which is never posted to Twitch). Messages that name the bot
  (configurable `mentionWords`, default derived from the bot's username)
  always pass through immediately. `replyChance` (default 100%, adjustable in
  the widget's settings) additionally filters non-mention messages before
  they reach the character — lower values make the bot pickier.
- **Role awareness**: Twitch badges (broadcaster, moderator, VIP, subscriber,
  founder, staff…) are parsed from the IRC tags and shown to the character
  in brackets (`[Twitch][moderator] name: message`) plus in the widget's
  chat log, so it knows how to talk to specific people.
- **Safety**: bot's own messages are filtered (no reply loops), duplicate IRC
  deliveries are deduplicated, a configurable cooldown (default 5s) paces
  triggers, messages are truncated to Twitch's 500-character limit and
  rate-limited (~20 msgs / 30s), and credentials never leave your machine —
  the extension is fully local (loopback HTTP server + your own IRC
  connection).

## Install

> Do these **in order**. Missing one = broken extension.

### 1. Windows official builds only: install the launcher (mandatory)

The official Windows builds of AIRI ship an SDK loader bug
(`ERR_UNSUPPORTED_ESM_URL_SCHEME` when importing extension entrypoints) that
prevents **any** extension from starting. The extension **will not run** on
these builds unless you start AIRI through the launcher provided in
[`windows-workaround/`](windows-workaround/README.md).

1. Copy the whole extension folder into the installed app's userData:
   `%APPDATA%\ai.moeru.airi\extensions\v1\airi-twitch-chat\`
2. Copy `windows-workaround/airi-loader-injector.mjs` to
   `%APPDATA%\ai.moeru.airi\`
3. Edit `windows-workaround/AIRI.bat.template`, replacing every
   `<PLACEHOLDER>` with your paths (airi.exe, a Node 22+ folder, the
   extension folder, the userData folder), and save it as `AIRI.bat`
   anywhere convenient.
4. **Always start AIRI through that bat** — never by double-clicking
   `airi.exe` directly.

The launcher clears environment variables that break Electron, opens the
inspector ports the extension relies on, and applies the loader fix without
modifying the app. See `windows-workaround/README.md` for details.

### 2. Copy the extension folder

Copy the extension folder into AIRI's extensions directory. The exact path
depends on your setup:

- Official installed app (Windows): `%APPDATA%\ai.moeru.airi\extensions\v1\airi-twitch-chat\`
- Official app (Linux/macOS): the equivalent userData folder for your platform
- Dev build: `%APPDATA%\@proj-airi\stage-tamagotchi\extensions\v1\airi-twitch-chat\`

### 3. Create `config.json`

Create `config.json` next to `index.mjs` (copy `config.example.json`):

```json
{
  "username": "your_twitch_username",
  "oauth": "oauth:your_chat_token",
  "channels": ["#your_channel"]
}
```

Get a chat token at <https://twitchtokengenerator.com> (scopes `chat:edit`,
`chat:read`, `user:read:chat`). The token only grants chat read/write —
never share it, and never commit `config.json` to git.

### 4. Enable the extension

Create `extensions-v1.json` in the app's userData folder with:

```json
{
  "enabled": ["airi-twitch-chat"]
}
```

(Optional, for the launcher's reload fallback: add
`"autoReload": ["airi-twitch-chat"]`.)

### 5. Restart AIRI

Restart AIRI **through the launcher bat** (Windows official builds) or
normally (other setups). The config widget should open automatically.

### 6. Connect

Press **Connect** in the widget — the status dot turns green when the bot
joins your channel. Send a message in your channel; the character replies
and the reply is posted to chat.

### Requirements

- AIRI with the extension host (`extensions/v1`, manifest v1,
  `toolKit`/`gameletKit`) — at the time of writing that is the `main`
  branch / 0.11.3+ era source.
- Windows official builds: the launcher (step 1) — **mandatory**.
- Node 22+ available on the machine for the Windows launcher (any platform
  with an official build is unaffected).

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `username` | — | Twitch account that sends the messages |
| `oauth` | — | Chat token (`oauth:…`) |
| `channels` | — | Channels to join, with or without `#` |
| `autoReply` | `true` | Forward chat to the character and auto-post replies |
| `replyCooldownMs` | `5000` | Minimum gap between messages sent to the character (widget: "Message pacing"). Mentions always pass through immediately |
| `replyChance` | `1` | Probability (0–1) of forwarding a message that doesn't mention the bot (widget: "Reply chance %"). `1` = the character decides on every message |
| `chatLogLimit` | `200` | How many messages the chat log keeps and shows in the widget (widget: "Chat log size") |
| `mentionWords` | from `username` | Words that count as calling the bot ("starry", "@starry_sophie"…) — messages containing one are always forwarded |

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
- **Clear chat history** drives the AIRI main window through Chrome DevTools
  Protocol (`--remote-debugging-port=9223`, opened by the launcher): it
  creates a fresh session for the active card (reloading the current system
  prompt) and deletes the old one. Without the debug port the button reports
  a clear error instead of failing silently.

## Troubleshooting

- **The widget never opens / no extension at all**: on Windows official
  builds you almost certainly skipped step 1 (the launcher). Start AIRI
  through the bat and check that `airi-loader-injector.mjs` is in the
  userData folder.
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
- **"Clear chat history" fails**: the app is not running with
  `--remote-debugging-port=9223` — start it through the launcher bat.

## License

MIT — see [LICENSE](LICENSE).
