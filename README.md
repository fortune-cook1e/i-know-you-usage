# I Know Your Usage

Shows remaining Codex subscription quota and reset times in Pi's footer.

**Codex only.** Requires Pi's `openai-codex` OAuth login (tested with Pi 1.4.0). API keys, the newer `openai` login, and other providers are not supported.

## Why

Pi's conversation token counts don't show how much Codex account quota remains. This extension keeps that information visible without leaving Pi.

## Install globally

```sh
pi install git:github.com/fortune-cook1e/i-know-you-usage
```

Installed globally for every Pi project. Restart Pi, or run `/reload` in an existing session.

## Update

```sh
pi update git:github.com/fortune-cook1e/i-know-you-usage
```

Run `/reload` afterward.

## Use

Sign in through `/login` with the `openai-codex` provider, then select one of its models with `/model`.

Example footer:

```text
Codex · 5h left 82% (resets in 2h) · 7d left 66% (resets in 3d)
```

Refreshes automatically every 60 seconds. Run `/usage` to refresh manually. Failed queries show the last result as `stale`, or `usage unknown` if no result is available.
