# Optional Windows Desktop execution

The public repository includes the actual Desktop API, Discord relay, shared
Desktop action queue, Windows UI Automation helpers, and App Server thread
boundary used by Protocol Runner's serial and mixed modes. The default local
demonstration does not start any of these services.

## Requirements

- Windows with an unlocked interactive desktop and Codex Desktop running under
  the same user. The helper uses Windows UI Automation, visible sidebar labels,
  the composer and visible readback; it does not inject code into the app.
- The Node/pnpm versions in the root README, Python 3, and an installed,
  authenticated Codex CLI. Set `CODEX_CLI_PATH` to its executable or `.cmd` path.
- A Discord bot you control, a private server/channel, and bot access to read
  messages, send messages, read history, and create/manage companion channels.
  Message content must be available to the bot.
- A work plan whose contract and output locations exist in the chosen workspace.
  Use an exact, unambiguous visible Desktop thread label. A thread ID alone is
  not a visible sidebar selector.

This integration is experimental and sensitive to Codex Desktop UI changes.
This public extraction has not received a live end-to-end Desktop/Discord check.
A healthy HTTP endpoint does not prove UI selection or prompt submission works.
Keep initial execution supervised and inspect selection/readback results.

## Configure and start

Copy `.env.desktop.example` to `.env.desktop.local` and fill the required values.
The local file is ignored by Git. Use distinct, independently generated secrets
for Desktop access, relay publishing and relay administration. Match the Runner
client values to the corresponding service values, as shown in the example.
The launcher applies the explicit `--workspace` directory to both services.

From the repository root, after installing and building the workspace, run:

```powershell
pnpm desktop -- --workspace C:\work\my-project
```

This one foreground command loads `.env.desktop.local` and starts the included
Desktop API, relay, Runner API, driver, parallel executor and dashboard directly.
Ctrl+C stops this instance. No additional terminals, Windows scheduled task,
private runtime registry or reboot supervisor are needed. The workspace must
already exist. Live model calls can incur usage or charges under your Codex account.

The launcher uses these isolated default endpoints:

| Service | Loopback URL |
| --- | --- |
| Desktop API | `http://127.0.0.1:14825` |
| Discord relay | `http://127.0.0.1:14830` |
| Runner API | `http://127.0.0.1:14831` |
| Dashboard | `http://127.0.0.1:15174` |

The example file names the port overrides. The driver and executor health ports
are Runner API port plus one and plus two. If any required port is occupied, the
launcher refuses to claim it without altering the existing service. Choose
distinct ports instead of stopping an unrelated instance.

The launcher selects real Desktop/relay adapters, sets their backend URLs and
uses the selected workspace for contracts and execution. It keeps private
orchestration disabled by default. The Runner control token is separate from
integration tokens and is generated locally when no explicit token is supplied.

Desktop operator attention is disabled in the example. If enabled, point its
attention URL at the running dashboard's gate URL; the attention helper can
bring that window to the foreground without starting a private runtime.

`GET /healthz` reports process availability. Desktop observations use authenticated
`GET /api/codex-desktop/state`. The relay's authenticated `GET /api/state` reports
mappings; `/readyz` observes Desktop readiness. Keep responses local: they may
contain thread labels, paths or channel identifiers.

## Serial returns and mixed execution

The Runner API binds a companion Discord channel to the exact run and thread.
The relay's operator interface must be enabled for this binding. The driver
submits one eligible serial prompt through the Desktop API. Structured Runner
start/return commands remain the primary procedural state evidence; Discord
publishing is the companion communication path. The launcher also starts the
real parallel executor for mixed plans, with one worker by default and
`workspace-write` for the CLI worker sandbox.

`scripts/tools/codex_discord_publish.py` sends a final visible reply to a known
binding. The generated invocation supplies the channel and binding IDs. It reads
the publish token from its environment or the root `.env.desktop.local` file.
Generated commands use the installed helper's absolute path and the running
relay's actual URL, so a different workspace or custom relay port does not change
their destination. They are quoted for PowerShell and contain no credential.
Run `python scripts/tools/codex_discord_publish.py usage --format json` to inspect
its inputs. `preview` validates metadata without reading a token or sending a
message. Publish only deliberately selected final visible text, never raw
transcripts, tools, private reasoning or tokens.

## Trust and permissions

- Both integration HTTP servers bind only to loopback and require bearer tokens
  for control operations. Do not tunnel them onto a public network. Token holders
  can operate their corresponding local service.
- Anyone allowed to send commands in the configured Discord channels can request
  enabled relay actions. Channel access is a control boundary. Use a restricted
  server/category and review channel permissions before enabling the bot.
- Desktop prompts execute with that Desktop thread's existing permissions. UIA
  is not a sandbox. The ordinary App Server creation path requests
  `workspace-write`; existing thread settings remain their own.
- The Desktop queue serializes control and normally releases a queued batch after
  15 seconds. Wait/Allow controls coordinate workstation use; the countdown is
  not a human approval requirement or security boundary. Zero is not a disable
  setting. An unattended gate does not block prompting indefinitely.
- Defaults keep relay Desktop mutation stubbed and its operator interface
  disabled. The example explicitly enables both for this optional live profile.
- Relay state, helper failures and run artifacts can contain user text. Keep them
  in ignored local storage. Field redaction does not guarantee arbitrary model
  output is suitable for publication.

The separate private orchestration registry is not part of Protocol Runner. Its
relay adapter remains an optional external interface and defaults to disabled;
enabling it requires an explicit external CLI path. No private orchestration
database, RH system, host credentials, original runtime configuration or
historical messages are bundled here.
