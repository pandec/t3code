# Claude

T3 Code uses Claude Code's login and configuration. Start with the default provider for one
account. [Provider setup](./install.md#providers) covers installation and shared provider settings.

## Use multiple accounts with shared configuration

Use one shared Claude config directory and a shadow config directory for each additional account.
This keeps sessions and configuration shared while each account retains its own login.

Keep the first account in `~/.claude`. Log in with that path set explicitly:

```bash
CLAUDE_CONFIG_DIR=~/.claude claude auth login
```

The explicit path matters on macOS. Claude Code keys credentials by the exact
`CLAUDE_CONFIG_DIR` value, so an unset variable and an explicit `~/.claude` use different
keychain slots.

Sign the second account into a separate directory:

```bash
mkdir -p ~/.claude-t3/personal
CLAUDE_CONFIG_DIR=~/.claude-t3/personal claude auth login
```

Use `CLAUDE_CONFIG_DIR`, not `HOME`. Then add the accounts in **Settings → Providers**:

| Instance        | CLAUDE_CONFIG_DIR path | Shadow config dir path  |
| --------------- | ---------------------- | ----------------------- |
| Claude Work     | `~/.claude`            | Leave empty             |
| Claude Personal | `~/.claude`            | `~/.claude-t3/personal` |

Both instances must use the same **CLAUDE_CONFIG_DIR path**. T3 Code prepares the shadow directory
so both accounts share sessions, skills, agents, commands, global settings, and `CLAUDE.md` while
keeping credentials separate.

Some state remains private to each account. MCP server registrations and per-project prompt history
live in that account's `.claude.json`, so changes made with `claude mcp add` do not carry across
accounts.

Check the account shown in provider settings after signing in. Existing threads can switch between
Claude instances that share their **CLAUDE_CONFIG_DIR path**. A provider with a different config
path and no shadow directory is isolated and cannot continue those threads.

For named presets that only change API keys or endpoints, use the instance's **Environment
variables**. Variable assignments do not belong in **Launch arguments**.

## Switch accounts automatically

Set **Failover instance** on each provider to the other account. When an instance reports a usage
limit or a turn fails with a rate-limit error, new turns use the failover account until the limit
lifts, then return to the preferred account. The thread work log records both switches.

Automatic failover requires shared session state. Both providers must use the same
**CLAUDE_CONFIG_DIR path**, with additional accounts configured through shadow directories. T3 Code
does not move a thread to an account that cannot resume its conversation, so failover stays
disabled for isolated config directories.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between `100000` and
`1000000`. For example, `300000` asks Claude to summarize at about 300,000 tokens. This changes
when compaction happens, not the model's context window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Web and desktop offer **Compact context**
from the context meter and may suggest it when you return to a large older thread. See
[commands and skills](./composer.md#commands-and-skills) for using composer commands.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which limit was reached
and the remaining wait when Claude provides a reset time. Claude Code holds the turn until that
window reopens, so it can keep showing as working. Wait for the reset, or stop the turn and continue
later. The warning's timestamp shows when the displayed wait started.

## Skills

Claude skills come from the config directory's `skills` folder and the project's `.claude/skills`
folder. If both define the same name, the config-directory copy wins. Skills disabled in Claude's
settings do not appear in the composer.

Use `$` in the composer to select a skill. Skills marked `disable-model-invocation` can still be
started by you. Invoke those one per message. Claude directly runs only the last named skill and may
try to start earlier ones through its Skill tool, which refuses skills reserved for manual
invocation.

## OpenRouter

Create a Claude instance with an isolated config directory, such as `~/.claude_openrouter`, and keep
**Binary path** set to `claude`. In that instance's **Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a Claude Code session
using that directory before starting the router setup. Cached login credentials can conflict with
the router token.

Verify requests in OpenRouter's activity dashboard. For model-role overrides and current
compatibility requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Show CLIProxyAPI usage

A Claude instance that authenticates to a gateway with a bearer token does not report subscription
quota. If the gateway is
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), configure **Usage source** on the
provider instance:

- Leave **Management URL** empty to use the origin of `ANTHROPIC_BASE_URL`, or enter the gateway's
  management endpoint.
- Enter the gateway's management API key under **Management key**. T3 Code stores it as a server
  secret.

The usage meter then lists pooled Claude and Codex accounts, including priority and cooldown state,
and marks the account the gateway will serve next. Direct-account rows stay hidden for a gateway
thread because they cannot serve that thread. Gateway rows stay hidden for direct threads.

A rejected management key pauses probes for 10 minutes. CLIProxyAPI bans an IP for 30 minutes after
five rejected keys.

## Other routers

A local router uses an ordinary Claude provider instance. Give it an isolated config directory and
put the router's endpoint and credential variables in that instance's **Environment variables**.
Mark tokens and API keys as sensitive. The router must run where the environment can reach it.

For Claude Code Router, create the directory and authenticate it before adding the provider:

```bash
mkdir -p ~/.claude_router_home
ccr start
ccr activate
CLAUDE_CONFIG_DIR=~/.claude_router_home claude auth login
```

Copy the variables that `ccr activate` exports into the provider instance rather than relying on
global shell startup files. Follow the
[Claude Code Router instructions](https://github.com/musistudio/claude-code-router) for current
installation and routing configuration.
