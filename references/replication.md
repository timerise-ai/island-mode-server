# Replication: RxDB ↔ Firestore

The replica is an RxDB database with one collection per replicated Firestore
collection, kept live by `replicateFirestore` from
`rxdb/plugins/replication-firestore`.

Dependencies (local server `package.json`):

```json
{
  "dependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/config": "^4.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "async-mutex": "^0.5.0",
    "firebase": "11.10.0",
    "firebase-admin": "^13.6.1",
    "reflect-metadata": "^0.2.2",
    "rxdb": "^16.11.0",
    "rxjs": "^7.8.1"
  }
}
```

Both Firebase SDKs are required: **admin** to mint a custom token and verify
staff ID tokens; **client** because the replication plugin drives the client
SDK (and therefore runs under security rules — a feature, not a limitation).

## The checkpoint trap (read this before anything else)

The plugin pulls with `where(serverTimestampField, '>', checkpoint)`. Two
consequences that WILL bite silently:

1. **Every write the cloud app makes to a replicated collection must set
   `serverTimestamp: FieldValue.serverTimestamp()`** (and `_deleted: false` on
   create). A document written without it is never pulled — no error, no log,
   it simply doesn't exist for the site. Audit every cloud write path
   (creates, updates, webhooks, admin edits, seeds) when you adopt this.
2. **Deletes must be soft**: set `_deleted: true` + a fresh `serverTimestamp`.
   A hard `doc.delete()` never replicates; the site keeps serving the ghost.

Cheapest enforcement: one shared helper on the cloud —

```ts
import { FieldValue } from 'firebase-admin/firestore';

/** Merge into every write to a replicated collection. */
export function replicationStamp() {
  return { serverTimestamp: FieldValue.serverTimestamp(), _deleted: false };
}
```

## Storage: decide the loss window explicitly

```ts
// Memory storage: replica repopulates from Firestore on startup via replication.
// TRADE-OFF: a restart while OFFLINE loses all offline-created work
// (bookings, stock transactions, logs) — the exact data island mode exists
// to protect. Acceptable only if the box is on a UPS and restarts are rare.
storage: getRxStorageMemory(),
```

Memory storage is fine for the replica itself (it self-heals from the cloud)
but not for offline-created documents. Options, in order of preference:

| Option | Cost | Notes |
|---|---|---|
| Persistent RxDB storage (SQLite) | RxDB Premium license | Cleanest: everything survives restarts |
| Journal offline writes to an append-only file (JSONL) next to memory storage, replay into RxDB on boot | ~a day of work | Only offline-created/unsynced docs need journaling |
| Accept the loss window | free | Document it for operators; pair with `Restart=always` awareness — systemd restarting a crashed server mid-outage is silent data loss |

Whichever you choose, **say so in the runbook**. The earlier implementation
shipped memory storage while its deployment guide instructed operators to
provision a persistent data directory that nothing used.

## Schemas

RxDB needs a JSON schema per collection. Keep them permissive (`type:
'object'` for nested blobs) — the cloud owns validation. Declare the
meta-fields; the plugin manages `serverTimestamp`/`_deleted` itself (do NOT
declare those two).

```ts
import type { RxJsonSchema } from 'rxdb';

export interface RxBooking {
  id: string;
  locationId: string;
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED';
  cart: Record<string, unknown>;
  pricing: Record<string, unknown>;
  payment: Record<string, unknown>;
  contactInfo?: Record<string, unknown>;
  source: string;
  checkedInAt?: string;
  checkedInBy?: string;
  _offlineCreated?: boolean;
  _locallyModified?: boolean;
  createdAt: string;
  updatedAt: string;
}

export const bookingSchema: RxJsonSchema<RxBooking> = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 100 },       // primaryKey requires maxLength
    locationId: { type: 'string', maxLength: 100 },
    status: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'CANCELLED'] },
    cart: { type: 'object' },
    pricing: { type: 'object' },
    payment: { type: 'object' },
    contactInfo: { type: 'object' },
    source: { type: 'string' },
    checkedInAt: { type: 'string' },
    checkedInBy: { type: 'string' },
    _offlineCreated: { type: 'boolean' },
    _locallyModified: { type: 'boolean' },        // declare it — patches set it
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  required: ['id', 'status', 'locationId'],
};
```

Database service (framework-neutral core):

```ts
import { createRxDatabase, addRxPlugin, type RxDatabase, type RxCollection } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';

export interface DatabaseCollections {
  locations: RxCollection<any>;
  bookings: RxCollection<any>;
  inventory: RxCollection<any>;
  inventory_transactions: RxCollection<any>;
  locks: RxCollection<any>;
  lock_logs: RxCollection<any>;
  pricing: RxCollection<any>;
  staff: RxCollection<any>;
}
export type AppDatabase = RxDatabase<DatabaseCollections>;

export async function initDatabase(schemas: Record<keyof DatabaseCollections, any>): Promise<AppDatabase> {
  addRxPlugin(RxDBQueryBuilderPlugin);
  const db = await createRxDatabase<DatabaseCollections>({
    name: 'island-local',
    storage: getRxStorageMemory(),   // see the storage decision above
    multiInstance: false,            // single Node process
  });
  await db.addCollections(
    Object.fromEntries(Object.entries(schemas).map(([k, schema]) => [k, { schema }])) as any,
  );
  return db;
}
```

## Authenticating the replica: custom token bootstrap

The plugin uses the *client* SDK, so the local server signs in as a synthetic
user and Firestore security rules scope what it can touch:

```ts
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import * as admin from 'firebase-admin';
import { readFileSync } from 'fs';

export async function initFirebase(opts: {
  serviceAccountPath: string;   // Firebase Console → Service Accounts → new private key
  webApiKey: string;            // Project Settings → General → Web API key
}): Promise<{ firestore: Firestore; projectId: string; app: FirebaseApp }> {
  const serviceAccount = JSON.parse(readFileSync(opts.serviceAccountPath, 'utf-8'));
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  const projectId = serviceAccount.project_id as string;

  const app = initializeApp({ projectId, apiKey: opts.webApiKey });
  const firestore = getFirestore(app);

  // Admin SDK mints a token for the fixed uid the rules recognize.
  const customToken = await admin.auth().createCustomToken('local-server');
  await signInWithCustomToken(getAuth(app), customToken);

  return { firestore, projectId, app };
}
```

Security rules — give the synthetic uid exactly the tier each collection needs:

```
// firestore.rules
function isLocalServer() {
  return request.auth != null && request.auth.uid == 'local-server';
}

match /locations/{locationId} {
  allow read: if true;
  allow write: if isLocalServer();          // heartbeat writes lastHeartbeatAt
}
match /inventory/{itemId}  { allow read: if isLocalServer(); }   // pull-only
match /staff/{staffId}     { allow read: if isLocalServer(); }   // pull-only
match /bookings/{id}       { allow read, write: if isLocalServer(); } // bidirectional
match /locks/{id}          { allow read, write: if isLocalServer(); } // bidirectional
match /lockLogs/{id}       { allow write: if isLocalServer(); }  // push-only
match /inventory_transactions/{id} { allow write: if isLocalServer(); } // push-only
```

Limitation to accept: all sites share the uid `local-server`, so rules cannot
scope one site's server to its own documents — a compromised site box can read
other sites' bookings. If that matters, mint per-site tokens
(`createCustomToken(locationId)` plus a claims check in rules).

## The replication service

```ts
import { collection as fsCollection, query, where, getCountFromServer, type Firestore } from 'firebase/firestore';
import { replicateFirestore, type RxFirestoreReplicationState } from 'rxdb/plugins/replication-firestore';
import type { RxCollection } from 'rxdb';

interface ReplicationEntry {
  name: string;
  state: RxFirestoreReplicationState<any>;
  lastError: string | null;
  lastErrorAt: string | null;
}

export class ReplicationService {
  private replications: ReplicationEntry[] = [];

  constructor(
    private firestore: Firestore,
    private projectId: string,
    private db: { getCollection(name: string): RxCollection<any> },
    private locationId: string,
  ) {}

  startAll(): void {
    // Own config doc — pulled by document ID, no tenant-field filter.
    this.add('locations', replicateFirestore({
      replicationIdentifier: `pull-locations-${this.locationId}`,
      collection: this.db.getCollection('locations'),
      firestore: this.fs('locations'),
      pull: {},
      live: true,
      serverTimestampField: 'serverTimestamp',
    }));

    for (const name of ['inventory', 'pricing']) this.pullOnly(name);

    // Directory with multi-site membership: array-contains filter.
    this.add('staff', replicateFirestore({
      replicationIdentifier: `pull-staff-${this.locationId}`,
      collection: this.db.getCollection('staff'),
      firestore: this.fs('staff'),
      pull: { filter: [where('locationIds', 'array-contains', this.locationId)] },
      live: true,
      serverTimestampField: 'serverTimestamp',
    }));

    for (const name of ['bookings', 'locks']) this.bidirectional(name);
    for (const name of ['lock_logs', 'inventory_transactions']) this.pushOnly(name);
  }

  private fs(name: string) {
    return { projectId: this.projectId, database: this.firestore, collection: fsCollection(this.firestore, name) };
  }

  private pullOnly(name: string): void {
    this.add(name, replicateFirestore({
      replicationIdentifier: `pull-${name}-${this.locationId}`,
      collection: this.db.getCollection(name),
      firestore: this.fs(name),
      pull: { filter: [where('locationId', '==', this.locationId)] },
      live: true,
      serverTimestampField: 'serverTimestamp',
    }));
  }

  private bidirectional(name: string): void {
    this.add(name, replicateFirestore({
      replicationIdentifier: `sync-${name}-${this.locationId}`,
      collection: this.db.getCollection(name),
      firestore: this.fs(name),
      pull: { filter: [where('locationId', '==', this.locationId)] },
      // Echo prevention: only push docs this server created or modified.
      push: { filter: (doc: any) => doc._offlineCreated === true || doc._locallyModified === true },
      live: true,
      serverTimestampField: 'serverTimestamp',
    }));
  }

  private pushOnly(name: string): void {
    this.add(name, replicateFirestore({
      replicationIdentifier: `push-${name}`,
      collection: this.db.getCollection(name),
      firestore: this.fs(name),
      push: {},
      live: true,
      serverTimestampField: 'serverTimestamp',
    }));
  }

  private add(name: string, state: RxFirestoreReplicationState<any>): void {
    const entry: ReplicationEntry = { name, state, lastError: null, lastErrorAt: null };
    this.replications.push(entry);
    state.error$.subscribe((error) => {
      entry.lastError = error?.message || String(error);
      entry.lastErrorAt = new Date().toISOString();
    });
    // Clear the sticky error once a sync cycle completes, so /status
    // distinguishes "erroring now" from "errored once at 3am".
    state.active$.subscribe((active) => {
      if (!active && entry.lastError && entry.lastErrorAt) {
        const ageMs = Date.now() - new Date(entry.lastErrorAt).getTime();
        if (ageMs > 60_000) entry.lastError = null;
      }
    });
  }

  getStatus(): Array<{ name: string; active: boolean; error: string | null; errorAt: string | null }> {
    return this.replications.map((r) => ({
      name: r.name,
      active: !r.state.isStopped(),
      error: r.lastError,
      errorAt: r.lastErrorAt,
    }));
  }

  /** Cloud-side counts for the /status drift check (pull/bidirectional tiers only). */
  async getFirestoreCounts(): Promise<Record<string, number>> {
    const byLocation = (name: string) =>
      query(fsCollection(this.firestore, name), where('locationId', '==', this.locationId));
    const targets: Array<{ name: string; q: any }> = [
      { name: 'inventory', q: byLocation('inventory') },
      { name: 'pricing', q: byLocation('pricing') },
      { name: 'bookings', q: byLocation('bookings') },
      { name: 'locks', q: byLocation('locks') },
      { name: 'staff', q: query(fsCollection(this.firestore, 'staff'), where('locationIds', 'array-contains', this.locationId)) },
    ];
    const counts: Record<string, number> = {};
    await Promise.all(targets.map(async ({ name, q }) => {
      try {
        counts[name] = (await getCountFromServer(q)).data().count;
      } catch {
        counts[name] = -1;   // -1 = count unavailable (offline), not zero
      }
    }));
    return counts;
  }

  async stopAll(): Promise<void> {
    for (const r of this.replications) {
      if (!r.state.isStopped()) await r.state.cancel();
    }
  }
}
```

## Startup order

1. Init RxDB (collections + schemas).
2. Init Firebase (admin + client custom-token sign-in) and start replications.
3. Start heartbeats ([network-failover.md](network-failover.md)).
4. Listen on HTTP.

If the internet is down at boot, steps 2–3 must not crash the process: catch
and continue — replication resumes when connectivity returns, and the local
API can serve whatever the replica holds (empty on memory storage; another
reason to weigh persistent storage).

## Checklist

- [ ] Every collection assigned a tier; filters match the tier
- [ ] Cloud writes audited: all stamp `serverTimestamp` + `_deleted`
- [ ] Deletes are soft everywhere the site replicates
- [ ] Meta-fields declared in schemas (incl. `_locallyModified`)
- [ ] Storage loss window decided and written into the runbook
- [ ] Rules grant the synthetic uid exactly its tier, nothing more
- [ ] Boot survives an offline start
