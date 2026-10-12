import process from "node:process";
import { z } from "zod";
import { dataforseoGet, dataforseoPost } from "@/server/lib/dataforseo/core";
import { resolveDataforseoProvider } from "@/shared/dataforseo-provider";
import { loadLocalEnv } from "./cli-utils";

/**
 * Smoke-test the treg provider with real calls through the app's DataForSEO
 * transport. Two calls are free (account data, and a locations lookup that
 * exercises path parameters); keyword_overview for one keyword is billed at
 * about $0.024.
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
const userDataSchema = z.object({
  money: z.object({ balance: z.number().optional() }).optional(),
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

const checks: {
  label: string;
  call: () => Promise<unknown>;
  summarize: (result: unknown[]) => string;
}[] = [
  {
    label: "GET /v3/appendix/user_data (free)",
    call: () => dataforseoGet("/v3/appendix/user_data"),
    summarize: (result) => {
      const row = userDataSchema.safeParse(result[0]);
      return `account balance ${row.data?.money?.balance ?? "n/a"}`;
    },
  },
  {
    label: "GET /v3/serp/google/locations/us (free)",
    call: () => dataforseoGet("/v3/serp/google/locations/us"),
    summarize: (result) => `${result.length} locations`,
  },
  {
    label: "POST /v3/dataforseo_labs/google/keyword_overview/live (billed)",
    call: () =>
      dataforseoPost("/v3/dataforseo_labs/google/keyword_overview/live", [
        { keywords: ["seo"], location_code: 2840, language_code: "en" },
      ]),
    summarize: (result) => {
      const item = keywordOverviewSchema.safeParse(result[0]).data?.items?.[0];
      return `"${item?.keyword ?? "?"}" search volume ${item?.keyword_info?.search_volume ?? "n/a"}`;
    },
  },
];

let failed = false;
for (const check of checks) {
  console.log(`\n${check.label}`);
  try {
    const response = envelopeSchema.parse(await check.call());
    const task = response.tasks?.[0];
    console.log(
      `  status_code ${response.status_code} (task ${task?.status_code} ${task?.status_message ?? ""})`,
    );
    console.log(`  cost        ${response.cost ?? "n/a"}`);
    console.log(`  result      ${check.summarize(task?.result ?? [])}`);
    if (task?.status_code !== 20000) failed = true;
  } catch (error) {
    failed = true;
    console.error(
      `  failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
process.exit(failed ? 1 : 0);
