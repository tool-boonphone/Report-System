import { config as loadDotenv } from "dotenv";

export type SectionDbConfig = {
  section: "Boonphone" | "Fastfone365";
  url: string;
};

export function loadStagingEnv(envFile = ".env.staging") {
  loadDotenv({ path: envFile, override: true });
}

export function maskDatabaseUrl(url: string): string {
  return url.replace(/:([^:@/]+)@/, ":***@");
}

export function assertSafeStagingDatabaseUrl(url: string, section: string) {
  if (process.env.ALLOW_NON_STAGING_DATABASE === "true") return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${section} database URL is invalid`);
  }

  const target = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  const looksSafeForSetup =
    target.includes("staging") ||
    target.includes("stage") ||
    target.includes("test") ||
    target.includes("dev");

  if (!looksSafeForSetup) {
    throw new Error(
      `${section} database URL must include staging/test/dev in the host or database name. ` +
        "Set ALLOW_NON_STAGING_DATABASE=true only for a confirmed non-live DB."
    );
  }
}

export function getSectionDatabases(): SectionDbConfig[] {
  const boonphoneUrl =
    process.env.BOONPHONE_DATABASE_URL ||
    process.env.DATABASE_URL_BOONPHONE ||
    process.env.DATABASE_URL;
  const fastfoneUrl =
    process.env.FASTFONE_DATABASE_URL ||
    process.env.FASTFONE365_DATABASE_URL ||
    process.env.DATABASE_URL_FASTFONE365;

  if (!boonphoneUrl) {
    throw new Error(
      "Missing BOONPHONE_DATABASE_URL (or DATABASE_URL_BOONPHONE / DATABASE_URL)"
    );
  }

  const configs: SectionDbConfig[] = [
    { section: "Boonphone", url: boonphoneUrl },
  ];

  if (fastfoneUrl) {
    configs.push({ section: "Fastfone365", url: fastfoneUrl });
  } else {
    console.warn(
      "[staging] FASTFONE_DATABASE_URL is not set; Fastfone365 staging DB will be skipped."
    );
  }

  for (const config of configs) {
    assertSafeStagingDatabaseUrl(config.url, config.section);
  }

  return configs;
}
