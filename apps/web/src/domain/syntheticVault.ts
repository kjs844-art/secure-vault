import type { SyntheticVaultItem } from "./vault";
import { SyntheticSecret } from "./vault";

export const syntheticVault: readonly SyntheticVaultItem[] = [
  {
    metadata: {
      id: "fixture-openai-primary",
      serviceName: "OpenAI",
      accountHint: "demo-user@example.invalid",
      kind: "api_key",
      environment: "development",
      status: "rotation_due",
      privilegeLevel: "read_write",
      createdAt: "2026-05-24T09:00:00.000Z",
      lastRotatedAt: null,
      expiresAt: null,
      connectionLabels: ["Sample MCP Gateway", "Demo Writing Assistant"],
      notes: "Synthetic note that must never be sent to an AI provider.",
      sourceUrl: "https://example.invalid/openai-console",
    },
    secret: SyntheticSecret.fromFixture(
      "DEMO_VALUE_ONLY_OPENAI_NEVER_REAL.invalid",
    ),
  },
  {
    metadata: {
      id: "fixture-anthropic-primary",
      serviceName: "Anthropic",
      accountHint: "second-demo@example.invalid",
      kind: "api_key",
      environment: "test",
      status: "active",
      privilegeLevel: "read_only",
      createdAt: "2026-08-12T09:00:00.000Z",
      lastRotatedAt: "2026-08-20T09:00:00.000Z",
      expiresAt: "2026-12-31T23:59:59.000Z",
      connectionLabels: ["Sample Research Agent"],
      notes: "Contains a private project codename that must remain local.",
      sourceUrl: "https://example.invalid/anthropic-console",
    },
    secret: SyntheticSecret.fromFixture(
      "DEMO_VALUE_ONLY_ANTHROPIC_NEVER_REAL.invalid",
    ),
  },
  {
    metadata: {
      id: "fixture-mcp-connection",
      serviceName: "Synthetic MCP Server",
      accountHint: "local-demo-profile",
      kind: "mcp_credential",
      environment: "development",
      status: "active",
      privilegeLevel: "unknown",
      createdAt: "2026-09-01T09:00:00.000Z",
      lastRotatedAt: "2026-09-01T09:00:00.000Z",
      expiresAt: null,
      connectionLabels: ["Demo Desktop Client"],
      notes: "Local fixture notes are excluded by the AI allowlist.",
      sourceUrl: "https://example.invalid/mcp-docs",
    },
    secret: SyntheticSecret.fromFixture(
      "DEMO_VALUE_ONLY_MCP_NEVER_REAL.invalid",
    ),
  },
] as const;
