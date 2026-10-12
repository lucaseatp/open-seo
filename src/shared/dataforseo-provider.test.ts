import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BusinessTaskEndpoint } from "@/server/lib/dataforseo/business";
import type { LlmResponseModelSlug } from "@/server/lib/dataforseo/llm-models";
import type { AiEngine, AiModelApiEngine } from "@/shared/ai-visibility";
import {
  buildDataforseoRequest,
  isDataforseoConfigured,
  resolveDataforseoProvider,
  TregUnsupportedEndpointError,
} from "@/shared/dataforseo-provider";

const treg = resolveDataforseoProvider({
  DATAFORSEO_PROVIDER: "treg",
  TREG_TOKEN: "treg-token",
});

describe("resolveDataforseoProvider", () => {
  it("defaults to DataForSEO with the API key", () => {
    expect(resolveDataforseoProvider({ DATAFORSEO_API_KEY: "key" })).toEqual({
      kind: "dataforseo",
      apiKey: "key",
    });
  });

  it("selects treg without a DataForSEO key, defaulting the base URL", () => {
    expect(treg).toEqual({
      kind: "treg",
      token: "treg-token",
      baseUrl: "https://treg.to",
    });
    expect(
      resolveDataforseoProvider({
        DATAFORSEO_PROVIDER: " TREG ",
        TREG_TOKEN: "t",
        TREG_BASE_URL: "http://localhost:8000/",
      }),
    ).toMatchObject({ baseUrl: "http://localhost:8000" });
  });

  it.each([
    [{}, "Missing required environment variable: DATAFORSEO_API_KEY"],
    [
      { DATAFORSEO_PROVIDER: "tregg", DATAFORSEO_API_KEY: "key" },
      'DATAFORSEO_PROVIDER must be "dataforseo" or "treg", got "tregg"',
    ],
    [{ DATAFORSEO_PROVIDER: "treg", DATAFORSEO_API_KEY: "key" }, "TREG_TOKEN"],
    [
      { DATAFORSEO_PROVIDER: "treg", TREG_TOKEN: "t", TREG_BASE_URL: "treg" },
      "TREG_BASE_URL is not a valid URL",
    ],
    [
      {
        DATAFORSEO_PROVIDER: "treg",
        TREG_TOKEN: "t",
        TREG_BASE_URL: "ftp://x",
      },
      "TREG_BASE_URL must be an http(s) URL",
    ],
  ])("rejects %o", (env, message) => {
    expect(() => resolveDataforseoProvider(env)).toThrow(message);
  });

  it("counts a treg token as configured only when treg is selected", () => {
    expect(isDataforseoConfigured({ TREG_TOKEN: "t" })).toBe(false);
    expect(
      isDataforseoConfigured({ DATAFORSEO_PROVIDER: "treg", TREG_TOKEN: "t" }),
    ).toBe(true);
    expect(
      isDataforseoConfigured({
        DATAFORSEO_PROVIDER: "treg",
        DATAFORSEO_API_KEY: "key",
      }),
    ).toBe(false);
  });
});

describe("buildDataforseoRequest", () => {
  const direct = resolveDataforseoProvider({ DATAFORSEO_API_KEY: "key" });

  it("keeps the direct DataForSEO URL and Basic auth", () => {
    expect(
      buildDataforseoRequest(direct, "/v3/backlinks/summary/live"),
    ).toEqual({
      url: "https://api.dataforseo.com/v3/backlinks/summary/live",
      headers: { Authorization: "Basic key" },
    });
    expect(
      buildDataforseoRequest(direct, "/v3/serp/google/organic/live/advanced", {
        baseUrl: "https://sandbox.dataforseo.com",
      }).url,
    ).toBe(
      "https://sandbox.dataforseo.com/v3/serp/google/organic/live/advanced",
    );
  });

  it("calls the treg catalog id with the treg token and no DataForSEO auth", () => {
    expect(buildDataforseoRequest(treg, "/v3/backlinks/summary/live")).toEqual({
      url: "https://treg.to/call/dataforseo.web.backlinks.summary",
      headers: { "X-Treg-Token": "treg-token" },
    });
  });

  it("passes treg path parameters as query parameters", () => {
    expect(
      buildDataforseoRequest(treg, "/v3/serp/google/locations/us").url,
    ).toBe(
      "https://treg.to/call/dataforseo.x.serp-google-locations-country?country=us",
    );
  });

  it.each([
    "/v3/serp/google/organic/task_get/advanced/task-1",
    "/v3/backlinks/anchors/live",
  ])("fails fast on %s instead of calling DataForSEO", (path) => {
    expect(() => buildDataforseoRequest(treg, path)).toThrow(
      TregUnsupportedEndpointError,
    );
    expect(() => buildDataforseoRequest(treg, path)).toThrow(path);
  });

  it("refuses the DataForSEO sandbox host on treg", () => {
    expect(() =>
      buildDataforseoRequest(treg, "/v3/serp/google/organic/live/advanced", {
        baseUrl: "https://sandbox.dataforseo.com",
      }),
    ).toThrow(TregUnsupportedEndpointError);
  });
});

// Every DataForSEO path OpenSEO builds must be mapped to a treg id or listed
// as unsupported; an unlisted path would fail at runtime with "no mapping".
describe("treg mapping completeness", () => {
  const roots = ["src/server/lib/dataforseo", "web/src", "scripts"];
  const pathLiteral = /["'`](\/v3\/[^"'`\s]*)["'`]/g;

  // Paths built from a variable, with every value the variable can take.
  // Records keyed by the union make a new union member a type error here.
  const llmSlugs: Record<LlmResponseModelSlug, true> = {
    chat_gpt: true,
    claude: true,
    gemini: true,
    perplexity: true,
  };
  const trackingBases: Record<Exclude<AiEngine, AiModelApiEngine>, string> = {
    chatgpt: "/v3/ai_optimization/chat_gpt/llm_scraper",
    gemini: "/v3/ai_optimization/gemini/llm_scraper",
    google_ai_overview: "/v3/serp/google/organic",
  };
  const businessTasks: Record<BusinessTaskEndpoint, true> = {
    reviews: true,
    extended_reviews: true,
    my_business_updates: true,
  };
  const dynamic: Record<string, string[]> = {
    "/v3/serp/google/organic/task_get/advanced/${}": [
      "/v3/serp/google/organic/task_get/advanced/t",
    ],
    "/v3/serp/google/maps/task_get/advanced/${}": [
      "/v3/serp/google/maps/task_get/advanced/t",
    ],
    "/v3/serp/google/locations/${}": ["/v3/serp/google/locations/us"],
    "/v3/ai_optimization/${}/llm_responses/live": Object.keys(llmSlugs).map(
      (slug) => `/v3/ai_optimization/${slug}/llm_responses/live`,
    ),
    "/v3/ai_optimization/${}/llm_responses/models": Object.keys(llmSlugs).map(
      (slug) => `/v3/ai_optimization/${slug}/llm_responses/models`,
    ),
    "/v3/business_data/google/${}/task_get/${}": Object.keys(businessTasks).map(
      (endpoint) => `/v3/business_data/google/${endpoint}/task_get/t`,
    ),
    ...Object.fromEntries(
      Object.values(trackingBases).map((base) => [
        base,
        ["/task_post", "/task_get/advanced/t", "/live/advanced"].map(
          (suffix) => `${base}${suffix}`,
        ),
      ]),
    ),
  };

  function sourcePaths(): string[] {
    const files = roots.flatMap((root) =>
      readdirSync(root, { recursive: true, encoding: "utf8" })
        .filter((file) => /\.(ts|tsx|mjs)$/.test(file))
        .filter((file) => !file.includes(".test."))
        .map((file) => join(root, file)),
    );
    return files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(pathLiteral)].map((match) =>
        match[1].replace(/\$\{[^}]*\}/g, "${}"),
      ),
    );
  }

  it("covers every path the code calls", () => {
    const used = new Set(
      sourcePaths().flatMap((path) => {
        if (path.includes("${}") || dynamic[path]) {
          expect(dynamic, `expand ${path} in this test`).toHaveProperty([path]);
          return dynamic[path];
        }
        return [path];
      }),
    );
    // Sanity: the scan found the call sites.
    expect(used.size).toBeGreaterThan(40);
    const unmapped = [...used].filter((path) => {
      try {
        buildDataforseoRequest(treg, path);
        return false;
      } catch (error) {
        if (!(error instanceof TregUnsupportedEndpointError)) throw error;
        return error.reason.includes("no treg mapping");
      }
    });
    expect(unmapped).toEqual([]);
  });
});
