import { z } from 'zod';

/**
 * Optional, strict, additive run-config block that swaps the RESPONDER's
 * turn driver for OpenAI's Codex CLI. The requester keeps the built-in
 * adapter. When the block is absent nothing about the run changes and the
 * configDigest of a pre-existing config is byte-identical (the key is simply
 * not present in the canonical JSON).
 *
 * Codex talks to the same OpenAI-compatible endpoint the run's `model` block
 * names (base URL + model id), configured as a custom Codex `model_provider`
 * with `wire_api = "chat"` and `env_key = SHAREDEVAL_MODEL_API_KEY`; Codex
 * reads the credential from that variable itself, SharedEval never writes it
 * to disk.
 */
export const SHAREDEVAL_CODEX_HARNESS_ID_V1 = 'codex' as const;
export const DEFAULT_CODEX_COMMAND_V1 = 'codex' as const;
export const DEFAULT_CODEX_PROVIDER_ID_V1 = 'sharedeval' as const;

export const sharedevalCodexHarnessV1Schema = z
  .object({
    /** Executable Codex CLI; a bare name is resolved through PATH. */
    command: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .regex(/^[^\s"'`$;&|<>]+$/, 'must be a single executable path without shell syntax')
      .default(DEFAULT_CODEX_COMMAND_V1),
    /** Name of the generated `[model_providers.<id>]` table in config.toml. */
    providerId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, 'must be a TOML bare key')
      .default(DEFAULT_CODEX_PROVIDER_ID_V1),
    /** Only the chat completions wire is supported by the bridge experiment. */
    wireApi: z.literal('chat').default('chat'),
    /** Extra `codex exec` flags; each entry is passed as one argv element. */
    extraArgs: z
      .array(z.string().min(1).max(256).regex(/^[^\0\n]+$/))
      .max(32)
      .optional(),
  })
  .strict()
  .default({
    command: DEFAULT_CODEX_COMMAND_V1,
    providerId: DEFAULT_CODEX_PROVIDER_ID_V1,
    wireApi: 'chat',
  });

export const sharedevalHarnessV1Schema = z
  .object({
    responder: z.literal(SHAREDEVAL_CODEX_HARNESS_ID_V1),
    codex: sharedevalCodexHarnessV1Schema,
  })
  .strict();

export type SharedevalCodexHarnessV1 = z.infer<typeof sharedevalCodexHarnessV1Schema>;
export type SharedevalHarnessV1 = z.infer<typeof sharedevalHarnessV1Schema>;
