// Where DataForSEO requests go. `dataforseo` (default) calls
// api.dataforseo.com with the operator's Basic credential. `treg` routes each
// call through a treg.to catalog endpoint, which injects its own DataForSEO
// credential and relays the vendor's response unchanged.
//
// Dependency-free on purpose: the app worker, the marketing site's free tools
// (web/) and the CLI scripts all build their DataForSEO requests here.

const DATAFORSEO_API_BASE = "https://api.dataforseo.com";
const DEFAULT_TREG_BASE_URL = "https://treg.to";

export type DataforseoProvider =
  | { kind: "dataforseo"; apiKey: string }
  | { kind: "treg"; token: string; baseUrl: string };

/** The env vars that pick and authenticate the provider. */
type DataforseoProviderEnv = {
  DATAFORSEO_PROVIDER?: string;
  DATAFORSEO_API_KEY?: string;
  TREG_TOKEN?: string;
  TREG_BASE_URL?: string;
};

class DataforseoProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataforseoProviderConfigError";
  }
}

/** A DataForSEO path the treg catalog cannot serve. Never retried elsewhere. */
export class TregUnsupportedEndpointError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(
      `DataForSEO endpoint ${path} is not available through treg: ${reason}`,
    );
    this.name = "TregUnsupportedEndpointError";
  }
}

/**
 * DataForSEO path (as OpenSEO calls it) -> treg catalog endpoint id. Every id
 * was checked with `treg catalog get`. All mapped paths are static; `{name}`
 * segments appear only in the unsupported list below.
 */
const TREG_ENDPOINT_IDS: Record<string, string> = {
  "/v3/backlinks/summary/live": "dataforseo.web.backlinks.summary",
  "/v3/backlinks/backlinks/live": "dataforseo.web.backlinks.list",
  "/v3/backlinks/referring_domains/live": "dataforseo.web.linking_domains.list",
  "/v3/backlinks/domain_pages_summary/live":
    "dataforseo.x.backlinks-domain-pages-summary-live",
  "/v3/backlinks/history/live": "dataforseo.x.backlinks-history-live",
  "/v3/dataforseo_labs/google/related_keywords/live":
    "dataforseo.google.keywords.ideas",
  "/v3/dataforseo_labs/google/keyword_suggestions/live":
    "dataforseo.x.dataforseo-labs-google-keyword-suggestions-live",
  "/v3/dataforseo_labs/google/keyword_ideas/live":
    "dataforseo.x.dataforseo-labs-google-keyword-ideas-live",
  "/v3/dataforseo_labs/google/keyword_overview/live":
    "dataforseo.x.dataforseo-labs-google-keyword-overview-live",
  "/v3/dataforseo_labs/google/domain_rank_overview/live":
    "dataforseo.x.dataforseo-labs-google-domain-rank-overview-live",
  "/v3/dataforseo_labs/google/ranked_keywords/live":
    "dataforseo.google.domain.ranked_keywords",
  "/v3/dataforseo_labs/google/relevant_pages/live":
    "dataforseo.x.dataforseo-labs-google-relevant-pages-live",
  "/v3/dataforseo_labs/google/serp_competitors/live":
    "dataforseo.x.dataforseo-labs-google-serp-competitors-live",
  "/v3/dataforseo_labs/google/domain_intersection/live":
    "dataforseo.x.dataforseo-labs-google-domain-intersection-live",
  "/v3/keywords_data/google_ads/search_volume/live":
    "dataforseo.google.keywords.volume",
  "/v3/keywords_data/google_ads/keywords_for_keywords/live":
    "dataforseo.x.keywords-data-google-ads-keywords-for-keywords-live",
  "/v3/serp/google/organic/live/advanced":
    "dataforseo.x.serp-google-organic-live-advanced",
  "/v3/serp/google/maps/live/advanced":
    "dataforseo.x.serp-google-maps-live-advanced",
  "/v3/serp/google/local_finder/live/advanced":
    "dataforseo.x.serp-google-local-finder-live-advanced",
  "/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced":
    "dataforseo.x.ai-optimization-chat-gpt-llm-scraper-live-advanced",
  "/v3/ai_optimization/gemini/llm_scraper/live/advanced":
    "dataforseo.x.ai-optimization-gemini-llm-scraper-live-advanced",
  "/v3/ai_optimization/chat_gpt/llm_responses/live":
    "dataforseo.x.ai-optimization-chat-gpt-llm-responses-live",
  "/v3/ai_optimization/claude/llm_responses/live":
    "dataforseo.x.ai-optimization-claude-llm-responses-live",
  "/v3/ai_optimization/gemini/llm_responses/live":
    "dataforseo.x.ai-optimization-gemini-llm-responses-live",
  "/v3/ai_optimization/perplexity/llm_responses/live":
    "dataforseo.x.ai-optimization-perplexity-llm-responses-live",
  "/v3/business_data/business_listings/search/live":
    "dataforseo.x.business-data-business-listings-search-live",
  "/v3/business_data/google/questions_and_answers/live":
    "dataforseo.x.business-data-google-questions-and-answers-live",
  "/v3/business_data/google/my_business_info/live":
    "dataforseo.x.business-data-google-my-business-info-live",
  "/v3/on_page/lighthouse/live/json":
    "dataforseo.x.on-page-lighthouse-live-json",
};

const NO_TASK_GET =
  "treg's catalog has no task_get route, so a queued task's results could not be collected";
const UNMAPPED = "OpenSEO has no treg mapping for this path";
const NO_CATALOG_ENTRY = "treg's catalog has no endpoint for this path";
const OWN_KEY_ONLY =
  "treg serves this endpoint only with the org's own connected DataForSEO key, not on treg credit";
const OVER_RESPONSE_BUFFER =
  "the country location list (about 9.5 MB for the US) exceeds treg's 8 MiB response buffer";

/**
 * Paths OpenSEO calls that treg cannot serve, and why. Kept explicit so a
 * missing mapping is a decision, not an oversight. Some of these exist in
 * treg's catalog but are refused here because the call cannot succeed on
 * treg credit: the business task_post routes (without task_get the task
 * would be billed and its results never read), account usage, and the
 * country location list.
 */
const TREG_UNSUPPORTED_ENDPOINTS: Record<string, string> = {
  "/v3/appendix/user_data": OWN_KEY_ONLY,
  "/v3/serp/google/locations/{country}": OVER_RESPONSE_BUFFER,
  "/v3/serp/google/organic/task_post": NO_CATALOG_ENTRY,
  "/v3/serp/google/organic/task_get/advanced/{id}": NO_TASK_GET,
  "/v3/serp/google/maps/task_post": NO_CATALOG_ENTRY,
  "/v3/serp/google/maps/task_get/advanced/{id}": NO_TASK_GET,
  "/v3/ai_optimization/chat_gpt/llm_scraper/task_post": NO_CATALOG_ENTRY,
  "/v3/ai_optimization/chat_gpt/llm_scraper/task_get/advanced/{id}":
    NO_TASK_GET,
  "/v3/ai_optimization/gemini/llm_scraper/task_post": NO_CATALOG_ENTRY,
  "/v3/ai_optimization/gemini/llm_scraper/task_get/advanced/{id}": NO_TASK_GET,
  "/v3/business_data/google/reviews/task_post": NO_TASK_GET,
  "/v3/business_data/google/extended_reviews/task_post": NO_TASK_GET,
  "/v3/business_data/google/my_business_updates/task_post": NO_TASK_GET,
  "/v3/business_data/google/{endpoint}/task_get/{id}": NO_TASK_GET,
  "/v3/business_data/business_listings/categories": NO_CATALOG_ENTRY,
  "/v3/ai_optimization/{model}/llm_responses/models": NO_CATALOG_ENTRY,
  "/v3/ai_optimization/llm_mentions/search/live": NO_CATALOG_ENTRY,
  "/v3/ai_optimization/llm_mentions/aggregated_metrics/live": NO_CATALOG_ENTRY,
  "/v3/ai_optimization/llm_mentions/top_pages/live": NO_CATALOG_ENTRY,
  "/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live":
    NO_CATALOG_ENTRY,
};

/** Whether `path` fills `template`, where a `{name}` segment matches any value. */
function matchesTemplate(template: string, path: string): boolean {
  const templateSegments = template.split("/");
  const pathSegments = path.split("/");
  return (
    templateSegments.length === pathSegments.length &&
    templateSegments.every(
      (segment, index) =>
        segment === pathSegments[index] ||
        (/^\{\w+\}$/.test(segment) && pathSegments[index] !== ""),
    )
  );
}

/** The treg catalog id for a DataForSEO path. */
function resolveTregEndpointId(path: string): string {
  const id = TREG_ENDPOINT_IDS[path];
  if (id) return id;
  for (const [template, reason] of Object.entries(TREG_UNSUPPORTED_ENDPOINTS)) {
    if (matchesTemplate(template, path))
      throw new TregUnsupportedEndpointError(path, reason);
  }
  throw new TregUnsupportedEndpointError(path, UNMAPPED);
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** Which provider `DATAFORSEO_PROVIDER` selects. Throws on an unknown value. */
export function selectedDataforseoProvider(
  env: DataforseoProviderEnv,
): DataforseoProvider["kind"] {
  const kind = trimmed(env.DATAFORSEO_PROVIDER)?.toLowerCase() ?? "dataforseo";
  if (kind === "dataforseo" || kind === "treg") return kind;
  throw new DataforseoProviderConfigError(
    `DATAFORSEO_PROVIDER must be "dataforseo" or "treg", got "${env.DATAFORSEO_PROVIDER}"`,
  );
}

/** Pick and validate the provider from env. Throws on a broken config. */
export function resolveDataforseoProvider(
  env: DataforseoProviderEnv,
): DataforseoProvider {
  if (selectedDataforseoProvider(env) === "dataforseo") {
    if (!env.DATAFORSEO_API_KEY)
      throw new DataforseoProviderConfigError(
        "Missing required environment variable: DATAFORSEO_API_KEY",
      );
    return { kind: "dataforseo", apiKey: env.DATAFORSEO_API_KEY };
  }
  const token = trimmed(env.TREG_TOKEN);
  if (!token)
    throw new DataforseoProviderConfigError(
      "DATAFORSEO_PROVIDER=treg needs TREG_TOKEN (a treg.to API token)",
    );
  const baseUrl = trimmed(env.TREG_BASE_URL) ?? DEFAULT_TREG_BASE_URL;
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    throw new DataforseoProviderConfigError(
      `TREG_BASE_URL is not a valid URL: "${baseUrl}"`,
    );
  }
  if (protocol !== "https:" && protocol !== "http:")
    throw new DataforseoProviderConfigError(
      `TREG_BASE_URL must be an http(s) URL: "${baseUrl}"`,
    );
  return { kind: "treg", token, baseUrl: baseUrl.replace(/\/+$/, "") };
}

/**
 * Whether SEO data calls have a credential: the API key, or a treg token
 * when treg is selected. A malformed provider value counts as the default;
 * the call itself reports it.
 */
export function isDataforseoConfigured(env: DataforseoProviderEnv): boolean {
  return trimmed(env.DATAFORSEO_PROVIDER)?.toLowerCase() === "treg"
    ? Boolean(trimmed(env.TREG_TOKEN))
    : Boolean(trimmed(env.DATAFORSEO_API_KEY));
}

/**
 * URL and auth header for one DataForSEO call. `baseUrl` overrides the
 * DataForSEO host (the sandbox); treg has no equivalent, so it is refused
 * there rather than sent to DataForSEO without a credential.
 */
export function buildDataforseoRequest(
  provider: DataforseoProvider,
  path: string,
  options: { baseUrl?: string } = {},
): { url: string; headers: Record<string, string> } {
  if (provider.kind === "dataforseo") {
    return {
      url: `${options.baseUrl ?? DATAFORSEO_API_BASE}${path}`,
      headers: { Authorization: `Basic ${provider.apiKey}` },
    };
  }
  if (options.baseUrl)
    throw new TregUnsupportedEndpointError(
      `${options.baseUrl}${path}`,
      "treg only reaches the production DataForSEO API",
    );
  return {
    url: `${provider.baseUrl}/call/${resolveTregEndpointId(path)}`,
    headers: { "X-Treg-Token": provider.token },
  };
}
