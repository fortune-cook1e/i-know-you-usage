import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import usageExtension from "../.pi/extensions/usage.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionCommandContext) => unknown };

const token = `test.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
  }),
).toString("base64url")}.signature`;

function quotaResponse(usedPercent = 18) {
  return new Response(
    JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: usedPercent,
          limit_window_seconds: 18_000,
          reset_at: 1_767_232_800,
        },
        secondary_window: {
          used_percent: 34,
          limit_window_seconds: 604_800,
          reset_at: 1_767_484_800,
        },
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function createHost(provider = "openai-codex", mode = "tui", oauth = true) {
  const events = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const statuses = new Map<string, string>();
  const setWidget = vi.fn<ExtensionContext["ui"]["setWidget"]>();
  const setStatus = vi.fn<ExtensionContext["ui"]["setStatus"]>((key, text) => {
    if (text === undefined) statuses.delete(key);
    else statuses.set(key, text);
  });
  const getProviderAuth = vi.fn<ExtensionContext["modelRegistry"]["getProviderAuth"]>(async () => ({
    auth: { apiKey: token },
  }));
  const isUsingOAuth = vi.fn<ExtensionContext["modelRegistry"]["isUsingOAuth"]>(() => oauth);
  const ctx = {
    mode,
    hasUI: mode === "tui",
    model: { provider, id: "test-model" },
    modelRegistry: {
      isUsingOAuth,
      getProviderAuth,
    },
    ui: { setStatus, setWidget },
  } as unknown as ExtensionCommandContext;
  const pi = {
    on: (name: string, handler: Handler) => events.set(name, handler),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
  } as unknown as ExtensionAPI;
  usageExtension(pi);
  return {
    ctx,
    setStatus,
    setWidget,
    getProviderAuth,
    isUsingOAuth,
    get status() {
      return statuses.get("codex-usage");
    },
    async emit(name: string, event: unknown = {}) {
      await events.get(name)?.(event, ctx);
    },
    async command(name = "usage", args = "") {
      const command = commands.get(name);
      if (!command) throw new Error(`Command /${name} is not registered`);
      await command.handler(args, ctx);
    },
  };
}

beforeEach(() => {
  vi.stubEnv("TZ", "UTC");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Codex usage in Pi", () => {
  it("shows account quota and reset times on session startup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => quotaResponse()),
    );
    const host = createHost();

    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);

    expect(host.status).toBe("Codex usage | 5h: 82% (reset 2:00 AM) | Weekly: 66% (reset Jan 4)");
    expect(host.setWidget).not.toHaveBeenCalled();
  });

  it("refreshes the displayed quota with /usage", async () => {
    const fetchUsage = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(quotaResponse())
      .mockResolvedValueOnce(quotaResponse(51));
    vi.stubGlobal("fetch", fetchUsage);
    const host = createHost();
    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);

    await host.command();

    expect(host.status).toBe("Codex usage | 5h: 49% (reset 2:00 AM) | Weekly: 66% (reset Jan 4)");
  });

  it("polls once per minute instead of continuously", async () => {
    const fetchUsage = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(quotaResponse())
      .mockResolvedValueOnce(quotaResponse(51));
    vi.stubGlobal("fetch", fetchUsage);
    const host = createHost();
    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(host.status).toBe("Codex usage | 5h: 49% (reset 2:00 AM) | Weekly: 66% (reset Jan 4)");
  });

  it("does not block startup and shares overlapping manual refreshes", async () => {
    let respond!: (response: Response) => void;
    const fetchUsage = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchUsage);
    const host = createHost();
    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);

    const first = host.command();
    const second = host.command();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchUsage).toHaveBeenCalledTimes(1);

    respond(quotaResponse());
    await Promise.all([first, second]);
    expect(host.status).toBe("Codex usage | 5h: 82% (reset 2:00 AM) | Weekly: 66% (reset Jan 4)");
  });

  it("keeps the last good quota visibly stale after a failed refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(quotaResponse()).mockRejectedValueOnce(new Error("offline")),
    );
    const host = createHost();
    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);

    await host.command();

    expect(host.status).toBe(
      "Codex usage | 5h: 82% (reset 2:00 AM) | Weekly: 66% (reset Jan 4) | stale (0m old)",
    );
  });

  it("shows unknown rather than treating an unsuccessful HTTP response as quota", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(quotaResponse().body, { status: 503 })),
    );
    const host = createHost();

    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);

    expect(host.status).toBe("Codex usage | unknown");
  });

  it.each([
    ["out-of-range percentage", { used_percent: 101 }],
    ["missing reset", { reset_at: undefined }],
    ["invalid window length", { limit_window_seconds: 0 }],
  ])("does not invent quota from a payload with %s", async (_name, invalidFields) => {
    const payload = await quotaResponse().json();
    Object.assign(payload.rate_limit.primary_window, invalidFields);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(payload))),
    );
    const host = createHost();

    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);

    expect(host.status).toBe("Codex usage | unknown");
  });

  it("backs off repeated failures and returns to minute polling after recovery", async () => {
    const fetchUsage = vi
      .fn<typeof fetch>(async () => quotaResponse())
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchUsage);
    const host = createHost();
    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(119_999);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(239_999);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.status).toBe("Codex usage | 5h: 82% (reset 2:00 AM) | Weekly: 66% (reset Jan 4)");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchUsage).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["another provider", "anthropic", "tui", true],
    ["the unverified new OpenAI login", "openai", "tui", true],
    ["non-interactive mode", "openai-codex", "print", true],
    ["an API-key credential", "openai-codex", "tui", false],
  ])("does no background work for %s", async (_name, provider, mode, oauth) => {
    const fetchUsage = vi.fn<typeof fetch>(async () => quotaResponse());
    vi.stubGlobal("fetch", fetchUsage);
    const host = createHost(provider, mode, oauth);

    await host.emit("session_start");
    await host.command();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(fetchUsage).not.toHaveBeenCalled();
    expect(host.status).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels and ignores late responses when switching away, then resumes on Codex", async () => {
    let respond!: (response: Response) => void;
    const fetchUsage = vi
      .fn<typeof fetch>(async () => quotaResponse())
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchUsage);
    const host = createHost();
    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);
    const signal = fetchUsage.mock.calls[0][1]?.signal;

    host.ctx.model = { ...host.ctx.model!, provider: "anthropic" };
    await host.emit("model_select", { model: host.ctx.model });
    expect(signal?.aborted).toBe(true);
    respond(quotaResponse());
    await vi.advanceTimersByTimeAsync(300_000);
    expect(host.status).toBeUndefined();
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    host.ctx.model = { ...host.ctx.model!, provider: "openai-codex" };
    await host.emit("model_select", { model: host.ctx.model });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.status).toBe("Codex usage | 5h: 82% (reset 2:00 AM) | Weekly: 66% (reset Jan 4)");
  });

  it("clears the status and polling timer when the extension runtime shuts down", async () => {
    const fetchUsage = vi.fn<typeof fetch>(async () => quotaResponse());
    vi.stubGlobal("fetch", fetchUsage);
    const host = createHost();
    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);

    await host.emit("session_shutdown", { reason: "reload" });
    await vi.advanceTimersByTimeAsync(300_000);

    expect(host.status).toBeUndefined();
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a hung HTTP query after ten seconds instead of waiting forever", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = init.signal!;
            requestSignal.addEventListener("abort", () => reject(requestSignal!.reason), {
              once: true,
            });
          }),
      ),
    );
    const host = createHost();
    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(requestSignal?.aborted).toBe(true);
    expect(host.status).toBe("Codex usage | unknown");
  });

  it("also bounds credential resolution and never sends a query with late credentials", async () => {
    const fetchUsage = vi.fn<typeof fetch>(async () => quotaResponse());
    vi.stubGlobal("fetch", fetchUsage);
    const host = createHost();
    let authenticate!: (auth: { auth: { apiKey: string } }) => void;
    host.getProviderAuth.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          authenticate = resolve;
        }),
    );
    await host.emit("session_start");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.status).toBe("Codex usage | unknown");
    await host.command();
    expect(host.status).toBe("Codex usage | 5h: 82% (reset 2:00 AM) | Weekly: 66% (reset Jan 4)");

    authenticate({ auth: { apiKey: token } });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(host.status).toBe("Codex usage | 5h: 82% (reset 2:00 AM) | Weekly: 66% (reset Jan 4)");
  });

  it.each(["180", "Thu, 01 Jan 2026 00:03:00 GMT"])(
    "honors Retry-After %s even for manual refresh",
    async (retryAfter) => {
      const fetchUsage = vi
        .fn<typeof fetch>(async () => quotaResponse())
        .mockResolvedValueOnce(
          new Response(null, {
            status: 429,
            headers: { "retry-after": retryAfter },
          }),
        );
      vi.stubGlobal("fetch", fetchUsage);
      const host = createHost();
      await host.emit("session_start");
      await vi.advanceTimersByTimeAsync(0);

      await host.command();
      await vi.advanceTimersByTimeAsync(179_999);
      expect(fetchUsage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchUsage).toHaveBeenCalledTimes(2);
      expect(host.status).toBe("Codex usage | 5h: 82% (reset 2:00 AM) | Weekly: 66% (reset Jan 4)");
    },
  );

  it("does not redraw the status when a manual refresh changes no visible text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => quotaResponse()),
    );
    const host = createHost();
    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);

    await host.command();

    expect(host.setStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing access token", ""],
    [
      "missing account claim",
      `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": {} })).toString("base64url")}.signature`,
    ],
    [
      "non-string account claim",
      `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: 42 } })).toString("base64url")}.signature`,
    ],
  ])("does not send a request with a %s", async (_name, access) => {
    const fetchUsage = vi.fn<typeof fetch>(async () => quotaResponse());
    vi.stubGlobal("fetch", fetchUsage);
    const host = createHost();
    host.getProviderAuth.mockResolvedValueOnce({ auth: { apiKey: access } });

    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchUsage).not.toHaveBeenCalled();
    expect(host.status).toBe("Codex usage | unknown");
  });

  it.each([
    ["signed out", ""],
    [
      "signed in to another account",
      `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "another-account" } })).toString("base64url")}.signature`,
    ],
  ])("does not carry old account quota over after the user %s", async (_name, access) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(quotaResponse()).mockRejectedValue(new Error("offline")),
    );
    const host = createHost();
    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);
    host.getProviderAuth.mockResolvedValueOnce({ auth: { apiKey: access } });

    await host.command();

    expect(host.status).toBe("Codex usage | unknown");
  });

  it("hides previous quota and stops polling when OAuth is no longer available", async () => {
    const fetchUsage = vi.fn<typeof fetch>(async () => quotaResponse());
    vi.stubGlobal("fetch", fetchUsage);
    const host = createHost();
    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);

    host.isUsingOAuth.mockReturnValue(false);
    await host.command();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(host.status).toBeUndefined();
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not apply Retry-After from a cancelled session's late response", async () => {
    let respond!: (response: Response) => void;
    const fetchUsage = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve;
          }),
      )
      .mockResolvedValueOnce(quotaResponse())
      .mockResolvedValueOnce(quotaResponse(51));
    vi.stubGlobal("fetch", fetchUsage);
    const host = createHost();
    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);
    host.ctx.model = { ...host.ctx.model!, provider: "anthropic" };
    await host.emit("model_select", { model: host.ctx.model });
    host.ctx.model = { ...host.ctx.model!, provider: "openai-codex" };
    await host.emit("model_select", { model: host.ctx.model });
    await vi.advanceTimersByTimeAsync(0);

    respond(new Response(null, { status: 429, headers: { "retry-after": "3600" } }));
    await vi.advanceTimersByTimeAsync(0);
    await host.command();

    expect(fetchUsage).toHaveBeenCalledTimes(3);
    expect(host.status).toBe("Codex usage | 5h: 49% (reset 2:00 AM) | Weekly: 66% (reset Jan 4)");
  });

  it("keeps absolute reset times stable without redrawing unchanged data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => quotaResponse()),
    );
    const host = createHost();
    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(host.status).toBe("Codex usage | 5h: 82% (reset 2:00 AM) | Weekly: 66% (reset Jan 4)");
    expect(host.setStatus).toHaveBeenCalledTimes(1);
  });

  it("updates stale age once a minute without bypassing network backoff", async () => {
    const fetchUsage = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(quotaResponse())
      .mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchUsage);
    const host = createHost();
    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);
    await host.command();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(host.status).toBe(
      "Codex usage | 5h: 82% (reset 2:00 AM) | Weekly: 66% (reset Jan 4) | stale (1m old)",
    );
  });

  it("uses the local timezone for reset clocks and dates across date boundaries", async () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => quotaResponse()),
    );
    const host = createHost();

    await host.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);

    expect(host.status).toBe("Codex usage | 5h: 82% (reset 6:00 PM) | Weekly: 66% (reset Jan 3)");
  });
});
