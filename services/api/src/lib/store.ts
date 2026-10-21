/**
 * Persistence.
 *
 * One DynamoDB table, single-table design:
 *
 *   pk                    sk                      item
 *   SESSION#<id>          META                    CareSession
 *   RINGLINK#<state>      META                    pending PKCE verifier (TTL)
 *   RINGACCT#default      META                    linked Ring tokens
 *   PLAN#<patientId>      META                    CarePlan overrides
 *   EVENT#<requestId>     META                    idempotency marker (TTL)
 *   TIMELINE#<yyyy-mm-dd> <iso>#<entryId>         TimelineEntry
 *   AUDIT#<sessionId>     <iso>#<auditId>         AuditRecord
 *
 * Sort keys are time-prefixed so the timeline and audit trail read back in order with a
 * single Query and no client-side sorting — which also means the demo's timeline cannot
 * show events out of order under load.
 *
 * Local mode keeps the identical key structure in a JSON file, so there is one code path
 * for reads and writes and nothing diverges between a teammate's laptop and Lambda.
 */

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { AuditRecord, CareSession, TimelineEntry } from '@careflow/shared';
import type { RingTokens } from '@careflow/ring';
import type { Config } from './config.js';

interface Row {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

interface Backend {
  put(row: Row): Promise<void>;
  get(pk: string, sk: string): Promise<Row | undefined>;
  queryByPk(pk: string, limit?: number): Promise<Row[]>;
  /** Conditional put used for idempotency; false means the key already existed. */
  putIfAbsent(row: Row): Promise<boolean>;
  scanPrefix(prefix: string, limit: number): Promise<Row[]>;
}

// ---------------------------------------------------------------------------
// Local JSON backend
// ---------------------------------------------------------------------------

class LocalBackend implements Backend {
  private rows = new Map<string, Row>();
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private key(pk: string, sk: string) {
    return `${pk}\u0000${sk}`;
  }

  /** ':memory:' keeps state in the process only — used by tests, so they leave no files. */
  private get ephemeral() {
    return this.path === ':memory:';
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (this.ephemeral) return;
    try {
      const raw = await readFile(this.path, 'utf8');
      for (const row of JSON.parse(raw) as Row[]) {
        this.rows.set(this.key(row.pk, row.sk), row);
      }
    } catch {
      // No state file yet: a fresh clone starts empty, which is the expected case.
    }
  }

  private persist() {
    if (this.ephemeral) return this.writing;

    // Writes are serialized, and write-then-rename means a crash mid-demo cannot leave a
    // half-written state file that fails to parse on restart.
    this.writing = this.writing.then(async () => {
      const body = JSON.stringify([...this.rows.values()], null, 2);
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, body, 'utf8');

      // On Windows, renaming over an existing file fails with EPERM/EBUSY whenever
      // something else holds a handle on it — which, in a OneDrive- or Dropbox-synced
      // folder, is routinely the sync client. Retry briefly, then fall back to writing in
      // place: losing atomicity on a local demo store is much better than losing the
      // write. (Noted in docs/friction/ — it cost a confusing twenty minutes.)
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(tmp, this.path);
          return;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
          if (!retryable || attempt >= 3) {
            await writeFile(this.path, body, 'utf8');
            await unlink(tmp).catch(() => {});
            return;
          }
          await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        }
      }
    });
    return this.writing;
  }

  async put(row: Row) {
    await this.load();
    this.rows.set(this.key(row.pk, row.sk), row);
    await this.persist();
  }

  async putIfAbsent(row: Row) {
    await this.load();
    const k = this.key(row.pk, row.sk);
    if (this.rows.has(k)) return false;
    this.rows.set(k, row);
    await this.persist();
    return true;
  }

  async get(pk: string, sk: string) {
    await this.load();
    return this.rows.get(this.key(pk, sk));
  }

  async queryByPk(pk: string, limit?: number) {
    await this.load();
    const out = [...this.rows.values()]
      .filter((r) => r.pk === pk)
      .sort((a, b) => a.sk.localeCompare(b.sk));
    return limit ? out.slice(-limit) : out;
  }

  async scanPrefix(prefix: string, limit: number) {
    await this.load();
    return [...this.rows.values()]
      .filter((r) => r.pk.startsWith(prefix))
      .sort((a, b) => a.sk.localeCompare(b.sk))
      .slice(-limit);
  }
}

// ---------------------------------------------------------------------------
// DynamoDB backend
// ---------------------------------------------------------------------------

class DynamoBackend implements Backend {
  private doc: Promise<import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient>;

  constructor(
    private readonly table: string,
    private readonly region: string,
  ) {
    // Imported lazily so local mode never pays the SDK load cost, and so a clone without
    // the AWS SDK installed still boots.
    this.doc = (async () => {
      const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
      const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
      return DynamoDBDocumentClient.from(new DynamoDBClient({ region: this.region }), {
        marshallOptions: { removeUndefinedValues: true },
      });
    })();
  }

  async put(row: Row) {
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    await (await this.doc).send(new PutCommand({ TableName: this.table, Item: row }));
  }

  async putIfAbsent(row: Row) {
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    try {
      await (
        await this.doc
      ).send(
        new PutCommand({
          TableName: this.table,
          Item: row,
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  }

  async get(pk: string, sk: string) {
    const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
    const res = await (await this.doc).send(
      new GetCommand({ TableName: this.table, Key: { pk, sk } }),
    );
    return res.Item as Row | undefined;
  }

  async queryByPk(pk: string, limit?: number) {
    const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
    const res = await (await this.doc).send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        Limit: limit,
      }),
    );
    return (res.Items ?? []) as Row[];
  }

  async scanPrefix(prefix: string, limit: number) {
    // Only used for the demo timeline, which spans at most a few days. A GSI would be the
    // right answer at real volume; noted in docs/aws-services.md rather than pretended away.
    const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
    const res = await (await this.doc).send(
      new ScanCommand({
        TableName: this.table,
        FilterExpression: 'begins_with(pk, :p)',
        ExpressionAttributeValues: { ':p': prefix },
      }),
    );
    return ((res.Items ?? []) as Row[])
      .sort((a, b) => a.sk.localeCompare(b.sk))
      .slice(-limit);
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  private readonly backend: Backend;

  constructor(private readonly config: Config) {
    this.backend =
      config.storage === 'dynamodb'
        ? new DynamoBackend(config.tableName, config.awsRegion)
        : new LocalBackend(config.localStatePath);
  }

  get mode() {
    return this.config.storage;
  }

  // -- sessions -------------------------------------------------------------

  async saveSession(session: CareSession): Promise<void> {
    await this.backend.put({ pk: `SESSION#${session.sessionId}`, sk: 'META', ...session });
  }

  async getSession(sessionId: string): Promise<CareSession | undefined> {
    const row = await this.backend.get(`SESSION#${sessionId}`, 'META');
    if (!row) return undefined;
    const { pk: _pk, sk: _sk, ...rest } = row;
    return rest as unknown as CareSession;
  }

  // -- idempotency ----------------------------------------------------------

  /**
   * Record a Ring delivery. Returns false when `request_id` has been seen before, which is
   * Ring's documented dedupe key — Ring retries on non-2xx, so without this a retried
   * doorbell press would start a second conversation.
   */
  async claimRingDelivery(requestId: string, eventId: string): Promise<boolean> {
    return this.backend.putIfAbsent({
      pk: `EVENT#${requestId}`,
      sk: 'META',
      eventId,
      at: new Date().toISOString(),
      // 7-day TTL: long enough to cover any plausible retry, short enough that the demo
      // table does not accumulate state forever.
      ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    });
  }

  // -- timeline -------------------------------------------------------------

  async appendTimeline(entry: Omit<TimelineEntry, 'entryId'>): Promise<TimelineEntry> {
    const full: TimelineEntry = { entryId: randomUUID(), ...entry };
    const day = full.at.slice(0, 10);
    await this.backend.put({
      pk: `TIMELINE#${day}`,
      sk: `${full.at}#${full.entryId}`,
      ...full,
    });
    return full;
  }

  async listTimeline(limit = 50): Promise<TimelineEntry[]> {
    const rows = await this.backend.scanPrefix('TIMELINE#', limit);
    return rows.map(stripKeys<TimelineEntry>);
  }

  // -- audit ----------------------------------------------------------------

  async appendAudit(record: Omit<AuditRecord, 'auditId'>): Promise<AuditRecord> {
    const full: AuditRecord = { auditId: randomUUID(), ...record };
    await this.backend.put({
      pk: `AUDIT#${full.sessionId}`,
      sk: `${full.at}#${full.auditId}`,
      ...full,
    });
    return full;
  }

  async listAudit(sessionId: string): Promise<AuditRecord[]> {
    const rows = await this.backend.queryByPk(`AUDIT#${sessionId}`);
    return rows.map(stripKeys<AuditRecord>);
  }

  // -- Ring account linking -------------------------------------------------

  /**
   * Hold the PKCE verifier between the authorize redirect and the callback.
   *
   * Keyed on the `state` we generated, which is also what proves the callback belongs to
   * the link attempt we started rather than one someone else began.
   */
  async savePendingLink(
    state: string,
    data: { verifier: string; createdAt: number; expiresAt: number },
  ): Promise<void> {
    await this.backend.put({
      pk: `RINGLINK#${state}`,
      sk: 'META',
      ...data,
      ttl: Math.floor(data.expiresAt / 1000),
    });
  }

  /**
   * Read a pending link and immediately invalidate it.
   *
   * Single-use by construction: a replayed callback finds nothing and is rejected, rather
   * than being allowed to exchange the same code twice.
   */
  async takePendingLink(
    state: string,
  ): Promise<{ verifier: string; createdAt: number; expiresAt: number } | undefined> {
    const row = await this.backend.get(`RINGLINK#${state}`, 'META');
    // A consumed marker is still a row, so it has to be checked explicitly. Without this
    // the second call returns a "pending link" with no verifier and replay protection is
    // silently absent — which a test caught, and which would have let the same
    // authorization code be exchanged twice.
    if (!row || row.consumed === true || typeof row.verifier !== 'string') return undefined;

    await this.backend.put({ pk: `RINGLINK#${state}`, sk: 'META', consumed: true, ttl: row.ttl });
    return {
      verifier: String(row.verifier),
      createdAt: Number(row.createdAt),
      expiresAt: Number(row.expiresAt),
    };
  }

  /** Tokens rotate on every refresh, so this is written each time, not just at link. */
  async saveRingTokens(tokens: RingTokens): Promise<void> {
    await this.backend.put({ pk: 'RINGACCT#default', sk: 'META', ...tokens });
  }

  async getRingTokens(): Promise<RingTokens | undefined> {
    const row = await this.backend.get('RINGACCT#default', 'META');
    if (!row?.accessToken) return undefined;
    return {
      accessToken: String(row.accessToken),
      refreshToken: String(row.refreshToken),
      expiresAt: Number(row.expiresAt),
    };
  }

  async listAllSessions(limit = 25): Promise<CareSession[]> {
    const rows = await this.backend.scanPrefix('SESSION#', limit);
    return rows
      .map(stripKeys<CareSession>)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

function stripKeys<T>(row: Row): T {
  const { pk: _pk, sk: _sk, ...rest } = row;
  return rest as unknown as T;
}
