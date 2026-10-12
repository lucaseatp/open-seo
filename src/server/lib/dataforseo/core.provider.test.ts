import { afterEach, describe, expect, it, vi } from "vitest";
import { dataforseoGet, dataforseoPost } from "@/server/lib/dataforseo/core";
import { AppError } from "@/server/lib/errors";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const envelope = {
  status_code: 20000,
  cost: 0.02,
  tasks: [{ status_code: 20000, cost: 0.02, result: [{ items: [] }] }],
};

type ProviderCase = {
  env: Record<string, string>;
  url: string;
  header: [string, string];
  absent: string;
};

describe("DataForSEO transport provider", () => {
  it.each<ProviderCase>([
    {
      env: { DATAFORSEO_PROVIDER: "", DATAFORSEO_API_KEY: "key" },
      url: "https://api.dataforseo.com/v3/backlinks/summary/live",
      header: ["Authorization", "Basic key"],
      absent: "X-Treg-Token",
    },
    {
      env: { DATAFORSEO_PROVIDER: "treg", TREG_TOKEN: "treg-token" },
      url: "https://treg.to/call/dataforseo.web.backlinks.summary",
      header: ["X-Treg-Token", "treg-token"],
      absent: "Authorization",
    },
  ])(
    "sends the same body and returns the same envelope via $url",
    async (c) => {
      for (const [name, value] of Object.entries(c.env))
        vi.stubEnv(name, value);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(envelope));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        dataforseoPost("/v3/backlinks/summary/live", [{ target: "a.com" }]),
      ).resolves.toEqual(envelope);

      const [url, init] = fetchMock.mock.calls[0];
      const headers = new Headers(init?.headers);
      expect(url).toBe(c.url);
      expect(headers.get(c.header[0])).toBe(c.header[1]);
      expect(init?.body).toBe('[{"target":"a.com"}]');
      expect(headers.has(c.absent)).toBe(false);
    },
  );

  it("fails an unsupported treg path before any request", async () => {
    vi.stubEnv("DATAFORSEO_PROVIDER", "treg");
    vi.stubEnv("TREG_TOKEN", "treg-token");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dataforseoGet("/v3/serp/google/organic/task_get/advanced/task-1"),
    ).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      name: "TregUnsupportedEndpointError",
      details: {
        provider: "treg",
        providerPath: "/v3/serp/google/organic/task_get/advanced/task-1",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<{ env: Record<string, string>; code: string; message: string }>([
    {
      env: { DATAFORSEO_PROVIDER: "", DATAFORSEO_API_KEY: "key" },
      code: "DATAFORSEO_AUTH_FAILED",
      message: "DataForSEO HTTP 401",
    },
    {
      env: { DATAFORSEO_PROVIDER: "treg", TREG_TOKEN: "revoked" },
      code: "TREG_AUTH_FAILED",
      message: "treg rejected TREG_TOKEN with HTTP 401 (revoked key)",
    },
  ])("maps a 401 to $code", async ({ env, code, message }) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ detail: "revoked key" }, { status: 401 }),
        ),
    );

    const request = dataforseoPost("/v3/backlinks/summary/live", []);
    await expect(request).rejects.toMatchObject({ code });
    await expect(request).rejects.toThrow(message);
  });

  describe("treg refusals", () => {
    function stubTreg(response: Response) {
      vi.stubEnv("DATAFORSEO_PROVIDER", "treg");
      vi.stubEnv("TREG_TOKEN", "treg-token");
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("reports a low treg balance, not a DataForSEO billing issue", async () => {
      stubTreg(
        Response.json(
          { detail: { error: "insufficient_balance", balance_micro: 0 } },
          { status: 402 },
        ),
      );

      const request = dataforseoPost("/v3/backlinks/summary/live", [], {
        classify: () => new AppError("BACKLINKS_BILLING_ISSUE"),
      });
      await expect(request).rejects.toMatchObject({
        code: "TREG_BALANCE_TOO_LOW",
      });
      await expect(request).rejects.toThrow("Top up at treg.to");
    });

    it("maps a treg 429 to RATE_LIMITED", async () => {
      stubTreg(
        Response.json(
          { detail: { error: "platform_daily_cap_reached" } },
          { status: 429 },
        ),
      );

      await expect(
        dataforseoPost("/v3/backlinks/summary/live", []),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    });

    it("does not retry a response over treg's buffer limit", async () => {
      const fetchMock = stubTreg(
        Response.json(
          { detail: { error: "response_buffer_limit" } },
          { status: 502 },
        ),
      );

      await expect(
        dataforseoPost("/v3/backlinks/summary/live", []),
      ).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
        message: "treg HTTP 502 on /v3/backlinks/summary/live",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
