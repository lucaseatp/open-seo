import { isHostedAuthMode } from "@/lib/auth-mode";
import { getOptionalEnvValue } from "@/server/lib/env-lookup";

export { getEnvValueSync, getOptionalEnvValue } from "@/server/lib/env-lookup";

export async function getRequiredEnvValue(name: string): Promise<string> {
  const value = await getOptionalEnvValue(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function isHostedServerAuthMode(): Promise<boolean> {
  return isHostedAuthMode(await getOptionalEnvValue("AUTH_MODE"));
}
