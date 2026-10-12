import process from "node:process";
import { z } from "zod";
import { dataforseoGet, dataforseoPost } from "@/server/lib/dataforseo/core";
import { AppError } from "@/server/lib/errors";
import { resolveDataforseoProvider } from "@/shared/dataforseo-provider";
import { loadLocalEnv } from "./cli-utils";

/**
 * Smoke-test the treg provider through the app's DataForSEO transport. The
 * first check is free and offline: a path treg can't serve must fail before
 * any request. The second is keyword_overview for one keyword, billed at
 * about $0.012. Exits 1 if either check fails.
 *
 * Usage: TREG_TOKEN=... pnpm treg:smoke   (TREG_BASE_URL is optional)
 */
loadLocalEnv();
process.env.DATAFORSEO_PROVIDER = "treg";

try {
  resolveDataforseoProvider(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
console.log(`treg base URL: ${process.env.TREG_BASE_URL || "https://treg.to"}`);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An unsupported path must be refused locally, with no network request. */
async function checkUnsupportedFailsFast(): Promise<boolean> {
  const path = "/v3/appendix/user_data";
  console.log(`\nGET ${path} (unsupported on treg; must fail offline)`);
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => {
    requests++;
    return Promise.reject(new Error("unexpected network request"));
  };
  try {
    await dataforseoGet(path);
    console.error("  failed: the call succeeded");
    return false;
  } catch (error) {
    const refused =
      error instanceof AppError &&
      error.name === "TregUnsupportedEndpointError" &&
      requests === 0;
    console.log(`  ${requests} network requests`);
    console.log(`  error       ${errorMessage(error)}`);
    if (!refused) console.error("  failed: expected a local refusal");
    return refused;
  } finally {
    globalThis.fetch = realFetch;
  }
}

const envelopeSchema = z.object({
  status_code: z.number().optional(),
  cost: z.number().optional(),
  tasks: z
    .array(
      z.object({
        status_code: z.number().optional(),
        status_message: z.string().optional(),
        result: z.array(z.unknown()).nullable().optional(),
      }),
    )
    .optional(),
});
const keywordOverviewSchema = z.object({
  items: z
    .array(
      z.object({
        keyword: z.string().optional(),
        keyword_info: z
          .object({ search_volume: z.number().nullable().optional() })
          .nullable()
          .optional(),
      }),
    )
    .nullable()
    .optional(),
});

async function checkKeywordOverview(): Promise<boolean> {
  console.log(
    "\nPOST /v3/dataforseo_labs/google/keyword_overview/live (billed, about $0.012)",
  );
  try {
    const response = envelopeSchema.parse(
      await dataforseoPost("/v3/dataforseo_labs/google/keyword_overview/live", [
        { keywords: ["seo"], location_code: 2840, language_code: "en" },
      ]),
    );
    const task = response.tasks?.[0];
    const item = keywordOverviewSchema.safeParse(task?.result?.[0]).data
      ?.items?.[0];
    console.log(
      `  status_code ${response.status_code} (task ${task?.status_code} ${task?.status_message ?? ""})`,
    );
    console.log(`  cost        ${response.cost ?? "n/a"}`);
    console.log(
      `  result      "${item?.keyword ?? "?"}" search volume ${item?.keyword_info?.search_volume ?? "n/a"}`,
    );
    return task?.status_code === 20000;
  } catch (error) {
    console.error(`  failed: ${errorMessage(error)}`);
    return false;
  }
}

const results = [
  await checkUnsupportedFailsFast(),
  await checkKeywordOverview(),
];
process.exit(results.every(Boolean) ? 0 : 1);
