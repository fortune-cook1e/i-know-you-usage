import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "codex-usage";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type QuotaWindow = {
  used_percent: number;
  limit_window_seconds: number;
  reset_at: number;
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid usage payload");
  }
  return value as Record<string, unknown>;
}

function parseQuota(data: unknown): QuotaWindow[] {
  const limits = record(record(data).rate_limit);
  return [limits.primary_window, limits.secondary_window].map((value) => {
    const window = record(value);
    const { used_percent, limit_window_seconds, reset_at } = window;
    if (
      typeof used_percent !== "number" ||
      !Number.isFinite(used_percent) ||
      used_percent < 0 ||
      used_percent > 100 ||
      typeof limit_window_seconds !== "number" ||
      !Number.isSafeInteger(limit_window_seconds) ||
      limit_window_seconds <= 0 ||
      typeof reset_at !== "number" ||
      reset_at <= 0 ||
      !Number.isFinite(new Date(reset_at * 1_000).getTime())
    )
      throw new Error("Invalid quota window");
    return { used_percent, limit_window_seconds, reset_at };
  });
}

function duration(milliseconds: number): string {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  if (minutes >= 1_440) {
    const hours = Math.floor((minutes % 1_440) / 60);
    return `${Math.floor(minutes / 1_440)}d${hours ? `${hours}h` : ""}`;
  }
  if (minutes >= 60) {
    const remainder = minutes % 60;
    return `${Math.floor(minutes / 60)}h${remainder ? `${remainder}m` : ""}`;
  }
  return `${minutes}m`;
}

function eligible(ctx: ExtensionContext): boolean {
  return (
    ctx.mode === "tui" &&
    ctx.model?.provider === "openai-codex" &&
    ctx.modelRegistry.isUsingOAuth(ctx.model)
  );
}

export default function usageExtension(pi: ExtensionAPI): void {
  const timeFormat = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let snapshot: { windows: QuotaWindow[]; fetchedAt: number; accountId: string } | undefined;
  let stale = false;
  let failures = 0;
  let generation = 0;
  let requestAbort: AbortController | undefined;
  let retryAt = 0;
  let displayed: string | undefined;

  function formatWindow(window: QuotaWindow): string {
    const weekly = window.limit_window_seconds === 604_800;
    const label = weekly ? "Weekly" : duration(window.limit_window_seconds * 1_000);
    const remaining = `${100 - window.used_percent}%`;
    const reset = (weekly ? dateFormat : timeFormat).format(new Date(window.reset_at * 1_000));
    return `${label}: ${remaining} (reset ${reset})`;
  }

  function stop(ctx: ExtensionContext): void {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    requestAbort?.abort();
    requestAbort = undefined;
    inFlight = undefined;
    snapshot = undefined;
    stale = false;
    failures = 0;
    retryAt = 0;
    if (ctx.mode === "tui" && displayed !== undefined) ctx.ui.setStatus(STATUS_KEY, undefined);
    displayed = undefined;
  }

  function render(ctx: ExtensionContext): void {
    let text = snapshot
      ? `Codex usage | ${snapshot.windows.map(formatWindow).join(" | ")}`
      : "Codex usage | unknown";
    if (snapshot && stale) text += ` | stale (${duration(Date.now() - snapshot.fetchedAt)} old)`;
    if (text === displayed) return;
    ctx.ui.setStatus(STATUS_KEY, text);
    displayed = text;
  }

  function schedule(ctx: ExtensionContext, delay: number): void {
    clearTimeout(timer);
    const due = Date.now() + delay;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (!eligible(ctx)) {
          stop(ctx);
          return;
        }
        render(ctx);
        const remaining = due - Date.now();
        if (remaining > 0) schedule(ctx, remaining);
        else void refresh(ctx);
      },
      Math.min(delay, 60_000),
    );
    timer.unref();
  }

  function refresh(ctx: ExtensionContext): Promise<void> {
    if (!eligible(ctx)) {
      stop(ctx);
      return Promise.resolve();
    }
    if (inFlight) return inFlight;
    if (Date.now() < retryAt) {
      schedule(ctx, retryAt - Date.now());
      return Promise.resolve();
    }
    clearTimeout(timer);
    timer = undefined;
    const version = generation;
    const controller = new AbortController();
    requestAbort = controller;
    const timeout = setTimeout(() => controller.abort(new Error("Usage query timed out")), 10_000);
    timeout.unref();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    inFlight = Promise.race([query(ctx, controller.signal), aborted])
      .catch(() => {
        if (version !== generation) return;
        stale = true;
        failures = Math.min(failures + 1, 4);
        render(ctx);
      })
      .finally(() => {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", onAbort);
        if (version !== generation) return;
        inFlight = undefined;
        requestAbort = undefined;
        const delay = Math.max(Math.min(60_000 * 2 ** failures, 900_000), retryAt - Date.now());
        schedule(ctx, delay);
      });
    return inFlight;
  }

  async function query(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    const resolved = await ctx.modelRegistry.getProviderAuth("openai-codex");
    signal.throwIfAborted();
    const access = resolved?.auth.apiKey;
    let accountId: string;
    try {
      if (!access) throw new Error("Codex login unavailable");
      // Decode only the routing claim; OpenAI still authenticates the actual token.
      const claims = record(
        JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8")),
      );
      const claim = record(claims["https://api.openai.com/auth"]).chatgpt_account_id;
      // oxlint-disable-next-line no-control-regex -- Reject HTTP header control characters in account IDs.
      if (typeof claim !== "string" || !claim.trim() || /[\u0000-\u001f\u007f]/.test(claim)) {
        throw new Error("Codex account unavailable");
      }
      accountId = claim;
    } catch {
      snapshot = undefined;
      throw new Error("Codex login unavailable");
    }
    if (snapshot && snapshot.accountId !== accountId) {
      snapshot = undefined;
      render(ctx);
    }
    const response = await fetch(USAGE_URL, {
      method: "GET",
      headers: {
        authorization: `Bearer ${access}`,
        "chatgpt-account-id": accountId,
        accept: "application/json",
      },
      redirect: "error",
      signal,
    });
    signal.throwIfAborted();
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after")?.trim();
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const until = Number.isFinite(seconds)
          ? Date.now() + Math.max(0, seconds) * 1_000
          : Date.parse(retryAfter);
        if (Number.isFinite(until)) retryAt = Math.max(Date.now(), until);
      }
      await response.body?.cancel();
      throw new Error("Usage query failed");
    }
    const data = await response.json();
    const windows = parseQuota(data);
    signal.throwIfAborted();
    snapshot = { windows, fetchedAt: Date.now(), accountId };
    stale = false;
    failures = 0;
    retryAt = 0;
    render(ctx);
  }

  pi.on("session_start", (_event, ctx) => {
    void refresh(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    stop(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    if (!eligible(ctx)) stop(ctx);
    else if (!timer && !inFlight) void refresh(ctx);
  });
  pi.registerCommand("usage", {
    description: "Refresh remaining Codex subscription usage",
    handler: async (_args, ctx) => {
      await refresh(ctx);
    },
  });
}
