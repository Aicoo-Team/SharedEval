import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { z } from 'zod';

import {
  assertJsonComplexityV1,
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from '../../contracts/json.js';
import type {
  SoAccessContext,
  SoAddress,
  SoAuditEvent,
  SoAuditSink,
  SoCapabilityGrant,
  SoGrantSource,
  SoGrantUsageStore,
  SoMessageDeliveryResult,
  SoMessageEnvelope,
  SoMessageTransport,
} from '../../execution/sharedos/v1/contracts.js';

const SESSION_DIRECTORY = '.sharedeval-sharedos-session';
const USAGE_DIRECTORY = 'usage';
const MESSAGE_DIRECTORY = 'messages';
const AUDIT_DIRECTORY = 'audit';
const RESPONDER_BINDING_DIRECTORY = 'responder-bindings';
const STAGING_DIRECTORY = 'staging';
const MUTATION_LOCK_DIRECTORY = 'mutation.lock';
const BINDING_FILE = 'binding.json';
const GRANTS_FILE = 'grants.json';
const CLOSED_FILE = 'closed.json';
const MAX_AUTHORITY_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_GRANTS = 10_000;
const LOCK_WAIT_LIMIT_MS = 15_000;
const LOCK_POLL_MS = 5;
const recordNamePattern = /^record-([0-9]{12})\.json$/;
const responderBindingNamePattern = /^task-[a-f0-9]{64}\.json$/;
const stageNamePattern = /^stage-[0-9a-f-]{36}\.json$/;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z.string().trim().min(1).max(256);
const timestampSchema = z.string().datetime({ offset: true });
const canonicalUtcTimestampSchema = z.string()
  .datetime({ offset: false, precision: 3 })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const grantPathSegmentSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^(?!\.{1,2}$)[^/\\\u0000-\u001f\u007f]+$/u, {
    message: 'grant resource path segments must be canonical',
  });
const enabledToolNamespacesSchema = z.array(identifierSchema).max(256)
  .superRefine((namespaces, refinement) => {
    if (new Set(namespaces).size !== namespaces.length) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'enabled tool namespaces must be unique',
      });
    }
  });

const addressSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), userId: identifierSchema }).strict(),
  z.object({ kind: z.literal('agent'), agentId: identifierSchema }).strict(),
  z.object({ kind: z.literal('group'), conversationId: identifierSchema }).strict(),
  z.object({ kind: z.literal('service'), serviceId: identifierSchema }).strict(),
]);

const resourceSchema = z.object({
  namespace: identifierSchema,
  path: z.array(grantPathSegmentSchema).max(64),
  owner: addressSchema.optional(),
}).strict();

const grantSchema: z.ZodType<SoCapabilityGrant> = z.object({
  id: identifierSchema,
  namespaceId: identifierSchema,
  subject: addressSchema,
  issuer: addressSchema,
  capabilities: z.array(z.object({
    resource: resourceSchema,
    actions: z.array(z.string().trim().min(1).max(128)).min(1).max(64),
    scope: z.enum(['exact', 'descendants']),
  }).strict()).min(1).max(64),
  constraints: z.object({
    purposes: z.array(z.string().trim().min(1).max(512)).min(1).max(64).optional(),
    notBefore: timestampSchema.optional(),
    expiresAt: timestampSchema.optional(),
    maxUses: z.number().int().safe().positive().optional(),
    delegationDepth: z.number().int().nonnegative().optional(),
  }).strict(),
  issuedAt: timestampSchema,
  revokedAt: timestampSchema.optional(),
  parentGrantId: identifierSchema.optional(),
  metadata: jsonObjectSchema.optional(),
}).strict();

const responderGrantSetSchema = z.object({
  taskId: identifierSchema,
  grantIds: z.array(identifierSchema).min(1),
}).strict();

const sessionBindingSchema = z.object({
  apiVersion: z.literal('sharedeval-sharedos-session-binding/v1'),
  runId: identifierSchema,
  namespaceId: identifierSchema,
  owner: addressSchema,
  authority: addressSchema,
  purpose: z.string().trim().min(1).max(512),
  startedAt: canonicalUtcTimestampSchema,
  toolSurface: z.literal('sharedos-runtime'),
  responderGrantSets: z.array(responderGrantSetSchema),
}).strict();

export type SharedOsSessionBindingV1 = Readonly<z.infer<typeof sessionBindingSchema>>;

export type OpenSharedOsSessionStoreV1Options = Readonly<{
  runDirectory: string;
  binding: SharedOsSessionBindingV1;
  grants: readonly SoCapabilityGrant[];
}>;

export class SharedOsResponderTaskAlreadyBoundErrorV1 extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super('Responder task already has an authoritative request');
    this.name = 'SharedOsResponderTaskAlreadyBoundErrorV1';
    this.taskId = taskId;
  }
}

const bindingEnvelopeSchema = z.object({
  apiVersion: z.literal('sharedeval-sharedos-binding-authority/v1'),
  bindingDigest: sha256Schema,
  binding: sessionBindingSchema,
}).strict();

const grantManifestSchema = z.object({
  apiVersion: z.literal('sharedeval-sharedos-grant-manifest/v1'),
  bindingDigest: sha256Schema,
  grantsDigest: sha256Schema,
  grants: z.array(grantSchema),
}).strict();

const messageProvenanceSchema = z.object({
  source: identifierSchema,
  parentIds: z.array(identifierSchema).max(64),
  metadata: jsonObjectSchema.optional(),
}).strict();

const messageEnvelopeSchema: z.ZodType<SoMessageEnvelope> = z.object({
  version: z.literal('1'),
  id: identifierSchema,
  sender: addressSchema,
  receiver: addressSchema,
  purpose: z.string().trim().min(1).max(512),
  payload: jsonValueSchema,
  traceId: identifierSchema,
  replyTo: identifierSchema.optional(),
  createdAt: timestampSchema,
  provenance: messageProvenanceSchema.optional(),
}).strict();

const accessContextSchema: z.ZodType<SoAccessContext> = z.object({
  namespaceId: identifierSchema,
  actor: addressSchema,
  authority: addressSchema,
  owner: addressSchema,
  purpose: z.string().trim().min(1).max(512),
  traceId: identifierSchema,
  enabledToolNamespaces: enabledToolNamespacesSchema,
  now: timestampSchema,
}).strict();

const auditEventSchema: z.ZodType<SoAuditEvent> = z.object({
  version: z.literal('1'),
  type: z.enum([
    'authority.resolved',
    'authorization.checked',
    'escalation.requested',
    'resource.invoked',
    'tool.catalog.listed',
    'tool.namespace.catalog.listed',
    'tool.namespace.selection.updated',
    'tool.invoked',
    'message.sent',
  ]),
  outcome: z.enum(['allowed', 'denied', 'succeeded', 'failed', 'escalated']),
  at: timestampSchema,
  traceId: identifierSchema,
  namespaceId: identifierSchema,
  actor: addressSchema,
  authority: addressSchema,
  owner: addressSchema,
  purpose: z.string().trim().min(1).max(512),
  resource: resourceSchema.optional(),
  action: z.string().trim().min(1).max(128).optional(),
  grantId: identifierSchema.optional(),
  authorityHash: identifierSchema.optional(),
  operationId: identifierSchema.optional(),
  tool: identifierSchema.optional(),
  messageId: identifierSchema.optional(),
  receiver: addressSchema.optional(),
  reason: z.string().max(2048).optional(),
  metadata: jsonObjectSchema.optional(),
}).strict();

const usageRecordSchema = z.object({
  apiVersion: z.literal('sharedeval-sharedos-usage-record/v1'),
  sequence: z.number().int().safe().nonnegative(),
  namespaceId: identifierSchema,
  grantId: identifierSchema,
  previousRecordDigest: sha256Schema.nullable(),
  recordDigest: sha256Schema,
}).strict();

const messageRecordSchema = z.object({
  apiVersion: z.literal('sharedeval-sharedos-message-record/v1'),
  sequence: z.number().int().safe().nonnegative(),
  envelope: messageEnvelopeSchema,
  previousRecordDigest: sha256Schema.nullable(),
  recordDigest: sha256Schema,
}).strict();

const auditRecordSchema = z.object({
  apiVersion: z.literal('sharedeval-sharedos-audit-record/v1'),
  sequence: z.number().int().safe().nonnegative(),
  event: auditEventSchema,
  previousRecordDigest: sha256Schema.nullable(),
  recordDigest: sha256Schema,
}).strict();

const responderBindingRecordSchema = z.object({
  apiVersion: z.literal('sharedeval-sharedos-responder-binding/v1'),
  traceId: identifierSchema,
  requestMessageId: identifierSchema,
  taskId: identifierSchema,
  grantIds: z.array(identifierSchema).min(1),
  bindingDigest: sha256Schema,
}).strict();

const closedAuthoritySchema = z.object({
  apiVersion: z.literal('sharedeval-sharedos-session-closed/v1'),
  namespaceId: identifierSchema,
  bindingDigest: sha256Schema,
  closeDigest: sha256Schema,
}).strict();

const lockOwnerSchema = z.object({
  apiVersion: z.literal('sharedeval-sharedos-mutation-lock/v1'),
  pid: z.number().int().safe().positive(),
  token: z.string().uuid(),
}).strict();

type UsageRecord = z.infer<typeof usageRecordSchema>;
type MessageRecord = z.infer<typeof messageRecordSchema>;
type AuditRecord = z.infer<typeof auditRecordSchema>;
type ResponderBindingRecord = z.infer<typeof responderBindingRecordSchema>;

export type SharedOsResponderGrantBindingOutcomeV1 = 'created' | 'replayed';

type SessionPaths = Readonly<{
  run: string;
  internal: string;
  usage: string;
  messages: string;
  audit: string;
  responderBindings: string;
  staging: string;
  mutationLock: string;
  binding: string;
  grants: string;
  closed: string;
}>;

type NormalizedAuthority = Readonly<{
  binding: SharedOsSessionBindingV1;
  bindingEnvelope: z.infer<typeof bindingEnvelopeSchema>;
  grantManifest: z.infer<typeof grantManifestSchema>;
  grantsById: ReadonlyMap<string, SoCapabilityGrant>;
  deferredGrantIds: ReadonlySet<string>;
  responderGrantSets: ReadonlyMap<string, readonly string[]>;
}>;

export async function openSharedOsSessionStoreV1(
  options: OpenSharedOsSessionStoreV1Options,
): Promise<SharedOsSessionStoreV1> {
  const authority = normalizeAuthority(options.binding, options.grants);
  const paths = sessionPaths(options.runDirectory);
  await establishDirectories(paths);
  const release = await acquireMutationLock(paths);
  try {
    await assertDirectoryLayout(paths, true);
    await cleanStagingDirectory(paths);
    await establishImmutableJson(
      paths,
      paths.binding,
      authority.bindingEnvelope,
      MAX_AUTHORITY_BYTES,
      'session binding',
    );
    await establishImmutableJson(
      paths,
      paths.grants,
      authority.grantManifest,
      MAX_AUTHORITY_BYTES,
      'grant manifest',
    );
    await assertAuthorityFiles(paths, authority);
    await scanUsageRecords(paths, authority);
    const messages = await scanMessageRecords(paths);
    await scanAuditRecords(paths, authority);
    const responderBindings = await scanResponderBindings(paths, authority);
    assertResponderBindingsReferenceMessages(responderBindings, messages, authority);
    await readClosedAuthority(paths, authority);
  } finally {
    await release();
  }
  return new SharedOsSessionStoreV1(paths, authority);
}

/**
 * Recover the immutable run timestamp without creating a session directory or
 * mutation lock. A present authority is accepted only after both committed
 * files, their digests, and their cross-binding constraints have been checked.
 */
export async function readSharedOsSessionStartedAtV1(
  runDirectory: string,
): Promise<string | null> {
  const paths = sessionPaths(runDirectory);
  if (!await existingRealDirectory(paths.run, 'SharedOS run directory')) return null;
  if (!await existingRealDirectory(paths.internal, 'SharedOS session directory')) return null;

  let bindingSource: string | undefined;
  let grantSource: string | undefined;
  while (true) {
    if (await waitForLiveMutationWriter(paths)) continue;
    [bindingSource, grantSource] = await readAuthoritySources(paths);
    if (await waitForLiveMutationWriter(paths)) continue;
    if (bindingSource !== undefined && grantSource !== undefined) break;
    if (bindingSource === undefined && grantSource === undefined) return null;

    // Close the release-before-observation race without accepting a stable
    // partial authority. A cooperative writer holds mutation.lock throughout
    // both immutable links.
    [bindingSource, grantSource] = await readAuthoritySources(paths);
    if (await waitForLiveMutationWriter(paths)) continue;
    if (bindingSource !== undefined && grantSource !== undefined) break;
    throw new Error('SharedOS session authority is incomplete');
  }

  let bindingEnvelope: z.infer<typeof bindingEnvelopeSchema>;
  try {
    bindingEnvelope = bindingEnvelopeSchema.parse(JSON.parse(bindingSource));
  } catch {
    throw new Error('Session binding is malformed');
  }
  if (bindingSource !== `${canonicalJson(bindingEnvelope)}\n`) {
    throw new Error('Session binding is not canonical committed authority');
  }
  if (bindingEnvelope.bindingDigest !== digestCanonical(bindingEnvelope.binding)) {
    throw new Error('Session binding digest does not match its committed bytes');
  }

  let grantManifest: z.infer<typeof grantManifestSchema>;
  try {
    grantManifest = grantManifestSchema.parse(JSON.parse(grantSource));
  } catch {
    throw new Error('Grant manifest is malformed');
  }
  if (grantSource !== `${canonicalJson(grantManifest)}\n`) {
    throw new Error('Grant manifest is not canonical committed authority');
  }
  if (
    grantManifest.bindingDigest !== bindingEnvelope.bindingDigest
    || grantManifest.grantsDigest !== digestCanonical(grantManifest.grants)
  ) {
    throw new Error('Grant manifest digest does not match its committed bytes');
  }

  const authority = normalizeAuthority(
    bindingEnvelope.binding,
    grantManifest.grants,
  );
  if (
    !isDeepStrictEqual(bindingEnvelope, authority.bindingEnvelope)
    || !isDeepStrictEqual(grantManifest, authority.grantManifest)
  ) {
    throw new Error('SharedOS session authority conflicts with its immutable binding');
  }
  await readClosedAuthority(paths, authority);
  return authority.binding.startedAt;
}

export class SharedOsSessionStoreV1 implements
  SoGrantSource,
  SoGrantUsageStore,
  SoAuditSink,
  SoMessageTransport {
  private operationTail: Promise<void> = Promise.resolve();
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly paths: SessionPaths,
    private readonly authority: NormalizedAuthority,
  ) {}

  async load(
    input: SoAccessContext,
    signal: AbortSignal,
  ): Promise<readonly SoCapabilityGrant[]> {
    signal.throwIfAborted();
    if (this.closing || this.closed) return [];
    const context = accessContextSchema.parse(input);
    return await this.enqueue(async () => withMutationLock(this.paths, async () => {
      signal.throwIfAborted();
      if (await readClosedAuthority(this.paths, this.authority)) {
        this.closed = true;
        return [];
      }
      await assertAuthorityFiles(this.paths, this.authority);
      if (!contextMatchesBinding(context, this.authority.binding)) return [];
      const messages = await scanMessageRecords(this.paths);
      const bindings = await scanResponderBindings(this.paths, this.authority);
      assertResponderBindingsReferenceMessages(bindings, messages, this.authority);
      const traceGrantIds = new Set(
        bindings.find(binding => binding.traceId === context.traceId)?.grantIds ?? [],
      );
      const grants = this.authority.grantManifest.grants.filter(grant => (
        grant.namespaceId === context.namespaceId
        && addressesEqual(grant.subject, context.actor)
        && addressesEqual(grant.issuer, context.authority)
        && (
          !this.authority.deferredGrantIds.has(grant.id)
          || traceGrantIds.has(grant.id)
        )
      )).map(grant => structuredClone(grant));
      signal.throwIfAborted();
      return grants;
    }, signal));
  }

  async getUsage(namespaceId: string, grantId: string): Promise<number> {
    this.assertUsageRequest(namespaceId, grantId);
    return await this.enqueue(async () => withMutationLock(this.paths, async () => {
      await assertAuthorityFiles(this.paths, this.authority);
      const records = await scanUsageRecords(this.paths, this.authority);
      return records.filter(record => record.grantId === grantId).length;
    }));
  }

  async tryConsume(
    namespaceId: string,
    grantId: string,
    maximumUses: number,
  ): Promise<boolean> {
    const grant = this.assertUsageRequest(namespaceId, grantId);
    if (grant.constraints.maxUses !== maximumUses) {
      throw new Error('Requested maximumUses conflicts with the immutable grant manifest');
    }
    if (this.closing || this.closed) return false;
    return await this.enqueue(async () => withMutationLock(this.paths, async () => {
      if (await readClosedAuthority(this.paths, this.authority)) {
        this.closed = true;
        return false;
      }
      await assertAuthorityFiles(this.paths, this.authority);
      const records = await scanUsageRecords(this.paths, this.authority);
      if (records.filter(record => record.grantId === grantId).length >= maximumUses) {
        return false;
      }
      await appendRecord(this.paths, this.paths.usage, usageRecordSchema, {
        apiVersion: 'sharedeval-sharedos-usage-record/v1',
        sequence: records.length,
        namespaceId,
        grantId,
        previousRecordDigest: records.at(-1)?.recordDigest ?? null,
      });
      return true;
    }));
  }

  record(input: SoAuditEvent): Promise<void> {
    if (this.closing || this.closed) {
      return Promise.reject(new Error('SharedOS session is closed'));
    }
    assertJsonComplexityV1(input, 'SharedOS audit event');
    const event = auditEventSchema.parse(input);
    assertAuditBinding(event, this.authority.binding);
    return this.enqueue(async () => withMutationLock(this.paths, async () => {
      if (await readClosedAuthority(this.paths, this.authority)) {
        this.closed = true;
        throw new Error('SharedOS session is closed');
      }
      await assertAuthorityFiles(this.paths, this.authority);
      const records = await scanAuditRecords(this.paths, this.authority);
      await appendRecord(this.paths, this.paths.audit, auditRecordSchema, {
        apiVersion: 'sharedeval-sharedos-audit-record/v1',
        sequence: records.length,
        event,
        previousRecordDigest: records.at(-1)?.recordDigest ?? null,
      });
    }));
  }

  deliver(
    inputContext: SoAccessContext,
    inputEnvelope: SoMessageEnvelope,
    signal: AbortSignal,
  ): Promise<SoMessageDeliveryResult> {
    signal.throwIfAborted();
    assertJsonComplexityV1(inputEnvelope, 'SharedOS message envelope');
    const envelope = messageEnvelopeSchema.parse(inputEnvelope);
    const context = accessContextSchema.parse(inputContext);
    if (!messageContextMatches(context, envelope, this.authority.binding)) {
      return Promise.resolve(failedDelivery(
        envelope,
        'MESSAGE_CONTEXT_MISMATCH',
        'Message context conflicts with the immutable session binding',
      ));
    }
    if (this.closing || this.closed) {
      return Promise.resolve(failedDelivery(
        envelope,
        'SESSION_CLOSED',
        'SharedOS session is closed',
      ));
    }
    return this.enqueue(async () => withMutationLock(this.paths, async () => {
      signal.throwIfAborted();
      if (await readClosedAuthority(this.paths, this.authority)) {
        this.closed = true;
        return failedDelivery(envelope, 'SESSION_CLOSED', 'SharedOS session is closed');
      }
      await assertAuthorityFiles(this.paths, this.authority);
      const records = await scanMessageRecords(this.paths);
      const sameId = records.find(record => record.envelope.id === envelope.id);
      if (sameId) {
        if (isDeepStrictEqual(sameId.envelope, envelope)) return acceptedDelivery(envelope);
        return failedDelivery(
          envelope,
          'MESSAGE_ID_CONFLICT',
          'Message ID conflicts with the durable envelope',
        );
      }
      if (
        envelope.replyTo === undefined
        && records.some(record => (
          record.envelope.replyTo === undefined
          && record.envelope.traceId === envelope.traceId
        ))
      ) {
        return failedDelivery(
          envelope,
          'MESSAGE_TRACE_ALREADY_HAS_REQUEST',
          'The trace already has an accepted request',
        );
      }
      signal.throwIfAborted();
      await appendRecord(this.paths, this.paths.messages, messageRecordSchema, {
        apiVersion: 'sharedeval-sharedos-message-record/v1',
        sequence: records.length,
        envelope,
        previousRecordDigest: records.at(-1)?.recordDigest ?? null,
      });
      return acceptedDelivery(envelope);
    }, signal));
  }

  readMessage(messageId: string): Promise<SoMessageEnvelope | null> {
    const parsedId = identifierSchema.parse(messageId);
    return this.enqueue(async () => withMutationLock(this.paths, async () => {
      await assertAuthorityFiles(this.paths, this.authority);
      const match = (await scanMessageRecords(this.paths))
        .find(record => record.envelope.id === parsedId);
      return match ? structuredClone(match.envelope) : null;
    }));
  }

  bindResponderGrantSet(input: {
    traceId: string;
    requestMessageId: string;
    taskId: string;
    grantIds: readonly string[];
  }): Promise<SharedOsResponderGrantBindingOutcomeV1> {
    const parsed = z.object({
      traceId: identifierSchema,
      requestMessageId: identifierSchema,
      taskId: identifierSchema,
      grantIds: z.array(identifierSchema).min(1),
    }).strict().parse(input);
    const grantIds = [...parsed.grantIds].sort(compareCodeUnits);
    if (new Set(grantIds).size !== grantIds.length) {
      return Promise.reject(new Error('Responder grant binding contains duplicate grant IDs'));
    }
    const configured = this.authority.responderGrantSets.get(parsed.taskId);
    if (!configured || !isDeepStrictEqual(configured, grantIds)) {
      return Promise.reject(new Error('Responder grant IDs conflict with the immutable task grant set'));
    }
    if (this.closing || this.closed) {
      return Promise.reject(new Error('SharedOS session is closed'));
    }
    return this.enqueue(async () => withMutationLock(this.paths, async () => {
      if (await readClosedAuthority(this.paths, this.authority)) {
        this.closed = true;
        throw new Error('SharedOS session is closed');
      }
      await assertAuthorityFiles(this.paths, this.authority);
      const messages = await scanMessageRecords(this.paths);
      const request = messages.find(record => record.envelope.id === parsed.requestMessageId)
        ?.envelope;
      if (!request || request.replyTo !== undefined) {
        throw new Error('Responder grant binding requires a durable request envelope');
      }
      if (request.traceId !== parsed.traceId) {
        throw new Error('Responder grant binding trace conflicts with the durable request');
      }
      const existing = await scanResponderBindings(this.paths, this.authority);
      assertResponderBindingsReferenceMessages(existing, messages, this.authority);
      assertDeferredGrantSubjects(parsed.grantIds, request.receiver, this.authority);
      const candidateWithoutDigest = {
        apiVersion: 'sharedeval-sharedos-responder-binding/v1' as const,
        traceId: parsed.traceId,
        requestMessageId: parsed.requestMessageId,
        taskId: parsed.taskId,
        grantIds,
      };
      const candidate = responderBindingRecordSchema.parse({
        ...candidateWithoutDigest,
        bindingDigest: digestCanonical(candidateWithoutDigest),
      });
      const sameTask = existing.find(record => record.taskId === parsed.taskId);
      if (sameTask && isDeepStrictEqual(sameTask, candidate)) return 'replayed';
      if (existing.some(record => record.traceId === parsed.traceId)) {
        throw new Error('Responder trace already has a conflicting immutable binding');
      }
      if (existing.some(record => record.requestMessageId === parsed.requestMessageId)) {
        throw new Error('Responder request already has a conflicting immutable binding');
      }
      if (sameTask) {
        throw new SharedOsResponderTaskAlreadyBoundErrorV1(parsed.taskId);
      }
      const destination = join(
        this.paths.responderBindings,
        `task-${sha256(parsed.taskId)}.json`,
      );
      await establishImmutableJson(
        this.paths,
        destination,
        candidate,
        MAX_RECORD_BYTES,
        'responder grant binding',
      );
      return 'created';
    }));
  }

  snapshotAudit(): Promise<{ nextSequence: number }> {
    return this.enqueue(async () => withMutationLock(this.paths, async () => {
      await assertAuthorityFiles(this.paths, this.authority);
      return { nextSequence: (await scanAuditRecords(this.paths, this.authority)).length };
    }));
  }

  readAuditWindow(input: {
    fromSequence: number;
    toSequenceExclusive: number;
  }): Promise<readonly SoAuditEvent[]> {
    const parsed = z.object({
      fromSequence: z.number().int().safe().nonnegative(),
      toSequenceExclusive: z.number().int().safe().nonnegative(),
    }).strict().parse(input);
    if (parsed.fromSequence > parsed.toSequenceExclusive) {
      return Promise.reject(new Error('Audit window sequences are reversed'));
    }
    return this.enqueue(async () => withMutationLock(this.paths, async () => {
      await assertAuthorityFiles(this.paths, this.authority);
      const records = await scanAuditRecords(this.paths, this.authority);
      if (parsed.toSequenceExclusive > records.length) {
        throw new Error('Audit window exceeds the durable sequence');
      }
      return records
        .slice(parsed.fromSequence, parsed.toSequenceExclusive)
        .map(record => structuredClone(record.event));
    }));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.enqueue(async () => withMutationLock(this.paths, async () => {
      await assertAuthorityFiles(this.paths, this.authority);
      await scanUsageRecords(this.paths, this.authority);
      const messages = await scanMessageRecords(this.paths);
      await scanAuditRecords(this.paths, this.authority);
      const responderBindings = await scanResponderBindings(this.paths, this.authority);
      assertResponderBindingsReferenceMessages(
        responderBindings,
        messages,
        this.authority,
      );
      const withoutDigest = {
        apiVersion: 'sharedeval-sharedos-session-closed/v1' as const,
        namespaceId: this.authority.binding.namespaceId,
        bindingDigest: this.authority.bindingEnvelope.bindingDigest,
      };
      const marker = closedAuthoritySchema.parse({
        ...withoutDigest,
        closeDigest: digestCanonical(withoutDigest),
      });
      await establishImmutableJson(
        this.paths,
        this.paths.closed,
        marker,
        MAX_RECORD_BYTES,
        'closed-session authority',
      );
      this.closed = true;
    })).catch(error => {
      this.closing = false;
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }

  private assertUsageRequest(namespaceId: string, grantId: string): SoCapabilityGrant {
    identifierSchema.parse(namespaceId);
    identifierSchema.parse(grantId);
    if (namespaceId !== this.authority.binding.namespaceId) {
      throw new Error('Usage namespace conflicts with the immutable session namespace');
    }
    const grant = this.authority.grantsById.get(grantId);
    if (!grant) throw new Error('Usage grant is absent from the immutable manifest');
    return grant;
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function normalizeAuthority(
  inputBinding: SharedOsSessionBindingV1,
  inputGrants: readonly SoCapabilityGrant[],
): NormalizedAuthority {
  assertJsonComplexityV1(inputBinding, 'SharedOS session binding');
  if (!Array.isArray(inputGrants) || inputGrants.length > MAX_SESSION_GRANTS) {
    throw new Error(`SharedOS grant manifest exceeds ${MAX_SESSION_GRANTS} grants`);
  }
  for (const inputGrant of inputGrants) {
    assertJsonComplexityV1(inputGrant, 'SharedOS grant');
  }
  const parsedBinding = sessionBindingSchema.parse(inputBinding);
  const taskIds = new Set<string>();
  const deferredGrantIds = new Set<string>();
  const responderGrantSets = new Map<string, readonly string[]>();
  const normalizedGrantSets = [...parsedBinding.responderGrantSets]
    .map(set => ({ ...set, grantIds: [...set.grantIds].sort(compareCodeUnits) }))
    .sort((left, right) => compareCodeUnits(left.taskId, right.taskId));
  for (const set of normalizedGrantSets) {
    if (taskIds.has(set.taskId)) throw new Error('Duplicate responder task grant set');
    taskIds.add(set.taskId);
    if (new Set(set.grantIds).size !== set.grantIds.length) {
      throw new Error('Responder task grant set contains duplicate grant IDs');
    }
    for (const grantId of set.grantIds) {
      if (deferredGrantIds.has(grantId)) {
        throw new Error('A deferred grant cannot belong to multiple responder task grant sets');
      }
      deferredGrantIds.add(grantId);
    }
    responderGrantSets.set(set.taskId, set.grantIds);
  }
  const normalizedBinding = sessionBindingSchema.parse({
    ...parsedBinding,
    responderGrantSets: normalizedGrantSets,
  });

  const grantsById = new Map<string, SoCapabilityGrant>();
  const normalizedGrants = inputGrants.map(input => {
    const grant = grantSchema.parse(input);
    if (grantsById.has(grant.id)) throw new Error(`Duplicate grant ID: ${grant.id}`);
    if (grant.namespaceId !== normalizedBinding.namespaceId) {
      throw new Error(`Grant ${grant.id} has a foreign namespace`);
    }
    if (!addressesEqual(grant.issuer, normalizedBinding.authority)) {
      throw new Error(`Grant ${grant.id} has a foreign issuer`);
    }
    if (grant.parentGrantId !== undefined || grant.constraints.delegationDepth !== undefined) {
      throw new Error(`Grant ${grant.id} is delegated; this session accepts root grants only`);
    }
    if (grant.revokedAt !== undefined) throw new Error(`Grant ${grant.id} is already revoked`);
    if (grant.constraints.expiresAt !== undefined) {
      throw new Error(`Grant ${grant.id} invents a wall-clock expiry`);
    }
    if (
      grant.issuedAt !== normalizedBinding.startedAt
      || grant.constraints.notBefore !== normalizedBinding.startedAt
      || !isDeepStrictEqual(grant.constraints.purposes, [normalizedBinding.purpose])
      || grant.constraints.maxUses === undefined
    ) {
      throw new Error(`Grant ${grant.id} conflicts with immutable run constraints`);
    }
    const capabilities = grant.capabilities.map(capability => {
      if (capability.scope !== 'exact') {
        throw new Error(`Grant ${grant.id} contains a non-exact capability`);
      }
      if (!addressesEqual(capability.resource.owner, normalizedBinding.owner)) {
        throw new Error(`Grant ${grant.id} contains a foreign resource owner`);
      }
      return {
        ...capability,
        actions: [...capability.actions].sort(compareCodeUnits),
      };
    }).sort((left, right) => compareCodeUnits(canonicalJson(left), canonicalJson(right)));
    const normalized = grantSchema.parse({ ...grant, capabilities });
    grantsById.set(normalized.id, normalized);
    return normalized;
  }).sort((left, right) => compareCodeUnits(left.id, right.id));

  for (const grantId of deferredGrantIds) {
    if (!grantsById.has(grantId)) {
      throw new Error(`Deferred responder grant ${grantId} is absent from the grant manifest`);
    }
  }
  const bindingDigest = digestCanonical(normalizedBinding);
  const grantsDigest = digestCanonical(normalizedGrants);
  return {
    binding: normalizedBinding,
    bindingEnvelope: bindingEnvelopeSchema.parse({
      apiVersion: 'sharedeval-sharedos-binding-authority/v1',
      bindingDigest,
      binding: normalizedBinding,
    }),
    grantManifest: grantManifestSchema.parse({
      apiVersion: 'sharedeval-sharedos-grant-manifest/v1',
      bindingDigest,
      grantsDigest,
      grants: normalizedGrants,
    }),
    grantsById,
    deferredGrantIds,
    responderGrantSets,
  };
}

function sessionPaths(runDirectory: string): SessionPaths {
  if (
    typeof runDirectory !== 'string'
    || runDirectory.length === 0
    || basename(runDirectory) === ''
    || runDirectory === dirname(runDirectory)
  ) {
    throw new Error('SharedOS run directory must be a concrete child path');
  }
  const internal = join(runDirectory, SESSION_DIRECTORY);
  return {
    run: runDirectory,
    internal,
    usage: join(internal, USAGE_DIRECTORY),
    messages: join(internal, MESSAGE_DIRECTORY),
    audit: join(internal, AUDIT_DIRECTORY),
    responderBindings: join(internal, RESPONDER_BINDING_DIRECTORY),
    staging: join(internal, STAGING_DIRECTORY),
    mutationLock: join(internal, MUTATION_LOCK_DIRECTORY),
    binding: join(internal, BINDING_FILE),
    grants: join(internal, GRANTS_FILE),
    closed: join(internal, CLOSED_FILE),
  };
}

async function establishDirectories(paths: SessionPaths): Promise<void> {
  await assertDirectory(dirname(paths.run), 'SharedOS run parent');
  await ensureDirectory(paths.run, 'SharedOS run directory');
  await ensureDirectory(paths.internal, 'SharedOS session directory');
  await ensureDirectory(paths.usage, 'SharedOS usage directory');
  await ensureDirectory(paths.messages, 'SharedOS message directory');
  await ensureDirectory(paths.audit, 'SharedOS audit directory');
  await ensureDirectory(paths.responderBindings, 'SharedOS responder-binding directory');
  await ensureDirectory(paths.staging, 'SharedOS staging directory');
}

async function ensureDirectory(path: string, label: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
    await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await assertDirectory(path, label);
}

async function assertDirectory(path: string, label: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} does not exist`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symlink or special file`);
  }
}

async function existingRealDirectory(path: string, label: string): Promise<boolean> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symlink or special file`);
  }
  return true;
}

async function readAuthoritySources(
  paths: SessionPaths,
): Promise<readonly [string | undefined, string | undefined]> {
  return await Promise.all([
    readOptionalBoundedRegular(
      paths.binding,
      MAX_AUTHORITY_BYTES,
      'session binding',
    ),
    readOptionalBoundedRegular(
      paths.grants,
      MAX_AUTHORITY_BYTES,
      'grant manifest',
    ),
  ]);
}

async function waitForLiveMutationWriter(paths: SessionPaths): Promise<boolean> {
  const startedAt = Date.now();
  let observed = false;
  while (true) {
    let lockStat;
    try {
      lockStat = await lstat(paths.mutationLock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return observed;
      throw error;
    }
    observed = true;
    if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
      throw new Error('Unsafe SharedOS mutation lock substitution');
    }

    let owner: z.infer<typeof lockOwnerSchema> | undefined;
    try {
      owner = lockOwnerSchema.parse(JSON.parse(await readBoundedRegular(
        join(paths.mutationLock, 'owner.json'),
        MAX_RECORD_BYTES,
        'SharedOS mutation lock owner',
      )));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('SharedOS mutation lock owner is malformed');
      }
    }
    if (owner && !processIsAlive(owner.pid)) {
      throw new Error('Stale SharedOS mutation lock makes the durable boundary indeterminate');
    }
    if (Date.now() - startedAt >= LOCK_WAIT_LIMIT_MS) {
      throw new Error('Timed out waiting for the SharedOS mutation lock');
    }
    await delay(LOCK_POLL_MS);
  }
}

async function assertDirectoryLayout(paths: SessionPaths, lockExpected: boolean): Promise<void> {
  await assertDirectory(paths.run, 'SharedOS run directory');
  await assertDirectory(paths.internal, 'SharedOS session directory');
  await assertDirectory(paths.usage, 'SharedOS usage directory');
  await assertDirectory(paths.messages, 'SharedOS message directory');
  await assertDirectory(paths.audit, 'SharedOS audit directory');
  await assertDirectory(paths.responderBindings, 'SharedOS responder-binding directory');
  await assertDirectory(paths.staging, 'SharedOS staging directory');
  if (lockExpected) await assertDirectory(paths.mutationLock, 'SharedOS mutation lock');
}

async function acquireMutationLock(
  paths: SessionPaths,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const token = randomUUID();
  const startedAt = Date.now();
  while (true) {
    signal?.throwIfAborted();
    try {
      await mkdir(paths.mutationLock, { mode: 0o700 });
      const owner = lockOwnerSchema.parse({
        apiVersion: 'sharedeval-sharedos-mutation-lock/v1',
        pid: process.pid,
        token,
      });
      const ownerStage = join(paths.mutationLock, `owner-${token}.stage`);
      await writeDurablyExclusive(
        ownerStage,
        `${canonicalJson(owner)}\n`,
        MAX_RECORD_BYTES,
      );
      await rename(ownerStage, join(paths.mutationLock, 'owner.json'));
      await syncDirectory(paths.mutationLock);
      await syncDirectory(paths.internal);
      let released = false;
      return async () => {
        if (released) return;
        const current = lockOwnerSchema.parse(JSON.parse(await readBoundedRegular(
          join(paths.mutationLock, 'owner.json'),
          MAX_RECORD_BYTES,
          'SharedOS mutation lock owner',
        )));
        if (current.pid !== process.pid || current.token !== token) {
          throw new Error('SharedOS mutation lock fencing authority changed');
        }
        await unlink(join(paths.mutationLock, 'owner.json'));
        await rmdir(paths.mutationLock);
        await syncDirectory(paths.internal);
        released = true;
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stat;
      try {
        stat = await lstat(paths.mutationLock);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw statError;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Unsafe SharedOS mutation lock substitution');
      }
      const ownerPath = join(paths.mutationLock, 'owner.json');
      let owner: z.infer<typeof lockOwnerSchema> | undefined;
      try {
        owner = lockOwnerSchema.parse(JSON.parse(await readBoundedRegular(
          ownerPath,
          MAX_RECORD_BYTES,
          'SharedOS mutation lock owner',
        )));
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code !== 'ENOENT') throw ownerError;
      }
      if (owner && !processIsAlive(owner.pid)) {
        throw new Error(
          'Stale SharedOS mutation lock makes the durable boundary indeterminate',
        );
      }
      if (Date.now() - startedAt >= LOCK_WAIT_LIMIT_MS) {
        throw new Error('Timed out waiting for the SharedOS mutation lock');
      }
      await delay(LOCK_POLL_MS);
    }
  }
}

async function withMutationLock<Result>(
  paths: SessionPaths,
  operation: () => Promise<Result>,
  signal?: AbortSignal,
): Promise<Result> {
  const release = await acquireMutationLock(paths, signal);
  try {
    await assertDirectoryLayout(paths, true);
    await cleanStagingDirectory(paths);
    return await operation();
  } finally {
    await release();
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function cleanStagingDirectory(paths: SessionPaths): Promise<void> {
  for (const name of await readdir(paths.staging)) {
    if (!stageNamePattern.test(name)) {
      throw new Error(`Unsafe unknown SharedOS staging entry: ${name}`);
    }
    const path = join(paths.staging, name);
    await assertRegularFile(path, MAX_AUTHORITY_BYTES, 'SharedOS staging file');
    await unlink(path);
  }
  await syncDirectory(paths.staging);
}

async function establishImmutableJson(
  paths: SessionPaths,
  destination: string,
  value: unknown,
  maximumBytes: number,
  label: string,
): Promise<void> {
  const expected = `${canonicalJson(value)}\n`;
  const stage = join(paths.staging, `stage-${randomUUID()}.json`);
  await writeDurablyExclusive(stage, expected, maximumBytes);
  try {
    try {
      await link(stage, destination);
      await syncDirectory(dirname(destination));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = await readBoundedRegular(destination, maximumBytes, label);
    if (existing !== expected) throw new Error(`${label} conflicts with immutable authority`);
  } finally {
    await unlink(stage).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await syncDirectory(paths.staging);
  }
}

async function assertAuthorityFiles(
  paths: SessionPaths,
  authority: NormalizedAuthority,
): Promise<void> {
  const bindingSource = await readBoundedRegular(
    paths.binding,
    MAX_AUTHORITY_BYTES,
    'session binding',
  );
  let bindingEnvelope: z.infer<typeof bindingEnvelopeSchema>;
  try {
    bindingEnvelope = bindingEnvelopeSchema.parse(JSON.parse(bindingSource));
  } catch {
    throw new Error('Session binding is malformed');
  }
  if (bindingEnvelope.bindingDigest !== digestCanonical(bindingEnvelope.binding)) {
    throw new Error('Session binding digest does not match its committed bytes');
  }
  if (!isDeepStrictEqual(bindingEnvelope, authority.bindingEnvelope)) {
    throw new Error('Session binding conflicts with immutable authority');
  }

  const grantSource = await readBoundedRegular(
    paths.grants,
    MAX_AUTHORITY_BYTES,
    'grant manifest',
  );
  let manifest: z.infer<typeof grantManifestSchema>;
  try {
    manifest = grantManifestSchema.parse(JSON.parse(grantSource));
  } catch {
    throw new Error('Grant manifest is malformed');
  }
  if (
    manifest.bindingDigest !== bindingEnvelope.bindingDigest
    || manifest.grantsDigest !== digestCanonical(manifest.grants)
  ) {
    throw new Error('Grant manifest digest does not match its committed bytes');
  }
  if (!isDeepStrictEqual(manifest, authority.grantManifest)) {
    throw new Error('Grant manifest conflicts with immutable authority');
  }
}

async function readClosedAuthority(
  paths: SessionPaths,
  authority: NormalizedAuthority,
): Promise<boolean> {
  const source = await readOptionalBoundedRegular(
    paths.closed,
    MAX_RECORD_BYTES,
    'closed-session authority',
  );
  if (source === undefined) return false;
  let marker: z.infer<typeof closedAuthoritySchema>;
  try {
    marker = closedAuthoritySchema.parse(JSON.parse(source));
  } catch {
    throw new Error('Closed-session authority is malformed');
  }
  const { closeDigest, ...withoutDigest } = marker;
  if (closeDigest !== digestCanonical(withoutDigest)) {
    throw new Error('Closed-session authority digest does not match its committed bytes');
  }
  if (
    marker.namespaceId !== authority.binding.namespaceId
    || marker.bindingDigest !== authority.bindingEnvelope.bindingDigest
  ) {
    throw new Error('Closed-session authority conflicts with the immutable session');
  }
  return true;
}

async function scanUsageRecords(
  paths: SessionPaths,
  authority: NormalizedAuthority,
): Promise<readonly UsageRecord[]> {
  const records = await scanDigestChain(paths.usage, usageRecordSchema, 'usage');
  for (const record of records) {
    if (
      record.namespaceId !== authority.binding.namespaceId
      || !authority.grantsById.has(record.grantId)
    ) {
      throw new Error('Usage record references foreign immutable authority');
    }
  }
  return records;
}

function scanMessageRecords(paths: SessionPaths): Promise<readonly MessageRecord[]> {
  return scanDigestChain(paths.messages, messageRecordSchema, 'message');
}

async function scanAuditRecords(
  paths: SessionPaths,
  authority: NormalizedAuthority,
): Promise<readonly AuditRecord[]> {
  const records = await scanDigestChain(paths.audit, auditRecordSchema, 'audit');
  for (const record of records) assertAuditBinding(record.event, authority.binding);
  return records;
}

async function scanDigestChain<Schema extends z.ZodTypeAny>(
  directory: string,
  schema: Schema,
  label: string,
): Promise<readonly z.infer<Schema>[]> {
  await assertDirectory(directory, `SharedOS ${label} directory`);
  const entries = await readdir(directory);
  const indexed = entries.map(name => {
    const match = recordNamePattern.exec(name);
    if (!match) throw new Error(`Unsafe unknown SharedOS ${label} record: ${name}`);
    return { name, sequence: Number(match[1]) };
  }).sort((left, right) => left.sequence - right.sequence);
  const records: z.infer<Schema>[] = [];
  let previousRecordDigest: string | null = null;
  for (const [index, entry] of indexed.entries()) {
    if (entry.sequence !== index) throw new Error(`SharedOS ${label} record sequence has a gap`);
    const source = await readBoundedRegular(
      join(directory, entry.name),
      MAX_RECORD_BYTES,
      `SharedOS ${label} record`,
    );
    let record: z.infer<Schema>;
    try {
      record = schema.parse(JSON.parse(source));
    } catch {
      throw new Error(`SharedOS ${label} record is malformed`);
    }
    const { recordDigest, ...withoutDigest } = record as {
      recordDigest: string;
      [key: string]: JsonValue;
    };
    if (
      record.sequence !== index
      || record.previousRecordDigest !== previousRecordDigest
      || recordDigest !== digestCanonical(withoutDigest)
    ) {
      throw new Error(`SharedOS ${label} record digest chain is invalid`);
    }
    records.push(record);
    previousRecordDigest = recordDigest;
  }
  return records;
}

async function scanResponderBindings(
  paths: SessionPaths,
  authority: NormalizedAuthority,
): Promise<readonly ResponderBindingRecord[]> {
  await assertDirectory(paths.responderBindings, 'SharedOS responder-binding directory');
  const records: ResponderBindingRecord[] = [];
  for (const name of (await readdir(paths.responderBindings)).sort(compareCodeUnits)) {
    if (!responderBindingNamePattern.test(name)) {
      throw new Error(`Unsafe unknown responder-binding record: ${name}`);
    }
    let record: ResponderBindingRecord;
    try {
      record = responderBindingRecordSchema.parse(JSON.parse(await readBoundedRegular(
        join(paths.responderBindings, name),
        MAX_RECORD_BYTES,
        'responder grant binding',
      )));
    } catch (error) {
      if (error instanceof Error && /regular|symlink|exceeds/.test(error.message)) throw error;
      throw new Error('Responder grant binding is malformed');
    }
    const { bindingDigest, ...withoutDigest } = record;
    if (
      bindingDigest !== digestCanonical(withoutDigest)
      || name !== `task-${sha256(record.taskId)}.json`
    ) {
      throw new Error('Responder grant binding digest is invalid');
    }
    const configured = authority.responderGrantSets.get(record.taskId);
    if (!configured || !isDeepStrictEqual(configured, record.grantIds)) {
      throw new Error('Responder grant binding conflicts with immutable task grants');
    }
    if (
      records.some(existing => existing.taskId === record.taskId)
      || records.some(existing => existing.traceId === record.traceId)
      || records.some(existing => existing.requestMessageId === record.requestMessageId)
    ) {
      throw new Error('Responder grant bindings contain conflicting authority');
    }
    records.push(record);
  }
  return records;
}

function assertResponderBindingsReferenceMessages(
  bindings: readonly ResponderBindingRecord[],
  messages: readonly MessageRecord[],
  authority: NormalizedAuthority,
): void {
  for (const binding of bindings) {
    const request = messages.find(record => (
      record.envelope.id === binding.requestMessageId
    ))?.envelope;
    if (
      !request
      || request.replyTo !== undefined
      || request.traceId !== binding.traceId
    ) {
      throw new Error(
        'Responder binding references a missing or conflicting durable request',
      );
    }
    assertDeferredGrantSubjects(binding.grantIds, request.receiver, authority);
  }
}

function assertDeferredGrantSubjects(
  grantIds: readonly string[],
  receiver: SoAddress,
  authority: NormalizedAuthority,
): void {
  if (receiver.kind !== 'agent') {
    throw new Error('Responder grant binding requires an agent request receiver');
  }
  for (const grantId of grantIds) {
    const grant = authority.grantsById.get(grantId);
    if (!grant || !addressesEqual(grant.subject, receiver)) {
      throw new Error('Responder grant subject conflicts with the request receiver');
    }
  }
}

async function appendRecord<Schema extends z.ZodTypeAny>(
  paths: SessionPaths,
  directory: string,
  schema: Schema,
  withoutDigest: Omit<z.input<Schema>, 'recordDigest'>,
): Promise<void> {
  const record = schema.parse({
    ...withoutDigest,
    recordDigest: digestCanonical(withoutDigest as JsonValue),
  });
  const destination = join(
    directory,
    `record-${String(record.sequence).padStart(12, '0')}.json`,
  );
  const source = `${canonicalJson(record)}\n`;
  const stage = join(paths.staging, `stage-${randomUUID()}.json`);
  await writeDurablyExclusive(stage, source, MAX_RECORD_BYTES);
  try {
    try {
      await link(stage, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('SharedOS record sequence lost its atomic publication race');
      }
      throw error;
    }
    await syncDirectory(directory);
  } finally {
    await unlink(stage).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await syncDirectory(paths.staging);
  }
}

async function writeDurablyExclusive(
  path: string,
  content: string,
  maximumBytes: number,
): Promise<void> {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > maximumBytes) throw new Error('SharedOS durable record exceeds its byte limit');
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOptionalBoundedRegular(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<string | undefined> {
  try {
    return await readBoundedRegular(path, maximumBytes, label);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readBoundedRegular(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<string> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`${label} must be a regular file, not a symlink`);
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size > maximumBytes) throw new Error(`${label} exceeds its byte limit`);
    const content = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(
        content,
        offset,
        content.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || pathAfter.dev !== before.dev
      || pathAfter.ino !== before.ino
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || offset !== before.size
    ) {
      throw new Error(`${label} changed during its bounded read`);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true })
        .decode(content.subarray(0, offset));
    } catch {
      throw new Error(`${label} is not valid UTF-8`);
    }
  } finally {
    await handle.close();
  }
}

async function assertRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<void> {
  await readBoundedRegular(path, maximumBytes, label);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function assertAuditBinding(
  event: SoAuditEvent,
  binding: SharedOsSessionBindingV1,
): void {
  if (
    event.namespaceId !== binding.namespaceId
    || !addressesEqual(event.authority, binding.authority)
    || !addressesEqual(event.owner, binding.owner)
    || event.purpose !== binding.purpose
  ) {
    throw new Error('Audit event conflicts with the immutable session binding');
  }
}

function contextMatchesBinding(
  context: SoAccessContext,
  binding: SharedOsSessionBindingV1,
): boolean {
  return context.namespaceId === binding.namespaceId
    && addressesEqual(context.authority, binding.authority)
    && addressesEqual(context.owner, binding.owner)
    && context.purpose === binding.purpose;
}

function messageContextMatches(
  context: SoAccessContext,
  envelope: SoMessageEnvelope,
  binding: SharedOsSessionBindingV1,
): boolean {
  return contextMatchesBinding(context, binding)
    && context.traceId === envelope.traceId
    && context.purpose === envelope.purpose
    && addressesEqual(context.actor, envelope.sender);
}

function acceptedDelivery(envelope: SoMessageEnvelope): SoMessageDeliveryResult {
  return {
    status: 'accepted',
    messageId: envelope.id,
    timestamp: envelope.createdAt,
  };
}

function failedDelivery(
  envelope: SoMessageEnvelope,
  code: string,
  message: string,
): SoMessageDeliveryResult {
  return {
    status: 'failed',
    messageId: envelope.id,
    timestamp: envelope.createdAt,
    error: { code, message, retryable: false },
  };
}

function addressesEqual(left: SoAddress | undefined, right: SoAddress): boolean {
  return left !== undefined && isDeepStrictEqual(left, right);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function digestCanonical(value: unknown): string {
  return sha256(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Durable SharedOS state must be JSON-safe');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareCodeUnits(left, right));
  return `{${entries.map(([key, entry]) => (
    `${JSON.stringify(key)}:${canonicalJson(entry)}`
  )).join(',')}}`;
}
