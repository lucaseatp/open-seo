# DataForSEO API Key Setup

OpenSEO uses [DataForSEO](https://dataforseo.com/?aff=255379) to fetch SEO data. It's a pay-as-you-go third-party service unaffiliated with OpenSEO. You need an API key to connect OpenSEO to it.

New DataForSEO accounts include $1 of free credit to test with, and the minimum top-up is $50.

## Get your API key

1. Go to [DataForSEO API Access](https://app.dataforseo.com/api-access?aff=255379) (create an account if you don't have one).
2. Click "Send by email" to get your credentials.
3. Copy the longer credentials labelled "Base64" credentials. This is the base64 encoded value of your DataForSEO email and API password in the format `email:password`.

## Where to set it

Set the value as `DATAFORSEO_API_KEY`:

- **Docker self-hosting:** in `.env` (see [`SELF_HOSTING_DOCKER.md`](./SELF_HOSTING_DOCKER.md)).
- **Cloudflare self-hosting:** in `.env.selfhost` (see [`SELF_HOSTING_CLOUDFLARE.md`](./SELF_HOSTING_CLOUDFLARE.md)). Legacy button/Wrangler deployments: as a Worker secret in the dashboard under `Settings` -> `Variables & Secrets`.
- **Local development:** in `.env.local` (see [`LOCAL_DEVELOPMENT.md`](./LOCAL_DEVELOPMENT.md)).

## Using treg

Instead of your own DataForSEO account, OpenSEO can send its DataForSEO requests through [treg](https://treg.to). treg holds the DataForSEO credential, bills your treg balance, and returns DataForSEO's response unchanged. You don't need `DATAFORSEO_API_KEY` in this mode.

Set these variables wherever you would set the API key:

```sh
DATAFORSEO_PROVIDER=treg
TREG_TOKEN=your-treg-api-token
# Optional, defaults to https://treg.to
# TREG_BASE_URL=https://treg.to
```

`DATAFORSEO_PROVIDER` accepts `dataforseo` (the default, which calls `api.dataforseo.com` with `DATAFORSEO_API_KEY`) or `treg`. Any other value, or `treg` without `TREG_TOKEN`, is a configuration error: the self-host preflight reports it and SEO data requests fail with a message naming the missing variable.

Each request goes to a treg catalog endpoint (`https://treg.to/call/<endpoint-id>`) with your token in the `X-Treg-Token` header. Path values such as a country code are sent as query parameters. OpenSEO keeps a fixed list of which DataForSEO endpoint maps to which treg endpoint.

### What doesn't work through treg

treg's catalog has no `task_get` routes, so DataForSEO's queued tasks can't be collected, and a few endpoints OpenSEO calls aren't in the catalog. OpenSEO refuses these requests before sending them. It never falls back to `api.dataforseo.com`.

| Feature                                                            | Behavior with treg                                                                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled rank tracking                                            | Queued checks fail and every keyword goes to the live fallback. Results still arrive, but at live prices (about three times the queued price). |
| AI Visibility scheduled collection                                 | Fails. Manual checks use live answers and work.                                                                                                |
| Local rank grid, business reviews and business updates (MCP tools) | Fail. These rely on queued tasks.                                                                                                              |
| Business category list (MCP `list_business_categories`)            | Fails.                                                                                                                                         |
| Brand lookup and Prompt Research (LLM Mentions)                    | Fail. treg lists LLM Mentions under different endpoint names.                                                                                  |
| LLM model lists for Prompt Explorer                                | OpenSEO uses its built-in model list.                                                                                                          |
| Location check when saving a rank tracker                          | Skipped. It uses the DataForSEO sandbox, which treg doesn't serve.                                                                             |

Everything else works through treg, including keyword research, domain overview, backlinks, live SERPs, Lighthouse, and manual AI Visibility checks.

To check a token, run `TREG_TOKEN=... pnpm treg:smoke`. It makes two free calls and one keyword overview call, which costs about $0.02.
