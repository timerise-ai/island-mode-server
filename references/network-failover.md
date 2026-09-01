# Outage detection and failover

Four cooperating monitors. Keep their responsibilities separate — each answers
one question for one audience.

| Monitor | Runs on | Question it answers | Cadence |
|---|---|---|---|
| Cloud heartbeat | local server | "Can I reach the cloud?" → drives ONLINE/OFFLINE mode + flush trigger | 5 s, offline after 3 consecutive failures |
| Firestore heartbeat | local server | "Is the site's server alive?" (writes `lastHeartbeatAt` to the site doc) | 30 s |
| Status cron | cloud | "Should customers be able to book this site right now?" (marks `status: offline`) | 1–5 min |
| Client failover | terminal PWAs | "Which API base URL do I use?" | 5 s |

## 1. Local server: cloud heartbeat + mode

```ts
import { EventEmitter } from 'events';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';

export type NetworkMode = 'online' | 'offline';

const FIRESTORE_HEARTBEAT_INTERVAL_MS = 30_000;

export class NetworkService extends EventEmitter {
  private mode: NetworkMode = 'online';
  private consecutiveFailures = 0;
  private lastHeartbeat: Date | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];

  constructor(
    private cloudApiUrl: string,
    private firestore: Firestore,
    private locationId: string,
    private intervalMs = 5_000,
    private failureThreshold = 3,
  ) {
    super();
  }

  start(): void {
    this.timers.push(setInterval(() => void this.checkCloud(), this.intervalMs));
    void this.checkCloud();
    this.timers.push(setInterval(() => void this.writeFirestoreHeartbeat(), FIRESTORE_HEARTBEAT_INTERVAL_MS));
    void this.writeFirestoreHeartbeat();
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  private async checkCloud(): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      const res = await fetch(`${this.cloudApiUrl}/api/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return this.onFailure(`HTTP ${res.status}`);

      this.consecutiveFailures = 0;
      this.lastHeartbeat = new Date();
      if (this.mode === 'offline') {
        this.mode = 'online';
        this.emit('online');          // SyncFlushService listens for this
      }
    } catch (err: any) {
      this.onFailure(err?.message ?? 'network error');
    }
  }

  private onFailure(reason: string): void {
    this.consecutiveFailures++;
    // Threshold, not first failure: one dropped packet must not flip the site.
    if (this.mode === 'online' && this.consecutiveFailures >= this.failureThreshold) {
      this.mode = 'offline';
      this.emit('offline');
    }
  }

  /**
   * Heartbeat into the site's own Firestore doc. The client SDK buffers this
   * while offline, which is exactly right: no fresh heartbeat reaches the
   * cloud during an outage, so the cron marks the site offline.
   * Deliberately does NOT stamp `serverTimestamp` — this write must not churn
   * the replication checkpoint every 30 s.
   */
  private async writeFirestoreHeartbeat(): Promise<void> {
    try {
      await setDoc(
        doc(this.firestore, 'locations', this.locationId),
        { lastHeartbeatAt: serverTimestamp() },
        { merge: true },
      );
    } catch {
      /* buffered or failed — the cron-side staleness check is the safety net */
    }
  }

  getMode(): NetworkMode { return this.mode; }
  getStatus() {
    return { mode: this.mode, lastHeartbeat: this.lastHeartbeat, consecutiveFailures: this.consecutiveFailures };
  }
}
```

## 2. Cloud: status cron

A scheduled endpoint scans site documents and flips `status` when
`lastHeartbeatAt` goes stale. Customer-facing booking UIs subscribe to the
site doc (`onSnapshot`) and disable the flow when `status === 'offline'` —
that is what prevents cloud/island double-booking.

```ts
// app/api/cron/server-status/route.ts — protect with your cron secret
import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

const STALE_THRESHOLD_MS = 5 * 60_000;   // ≥ cron cadence, or sites flap

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = getAdminDb();
  const snapshot = await db.collection('locations').get();
  const now = Date.now();
  const updates: Array<{ id: string; newStatus: string }> = [];

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    const last = data.lastHeartbeatAt?.toMillis?.();
    if (!last) continue;   // site not running a local server — leave it alone
    const newStatus = now - last > STALE_THRESHOLD_MS ? 'offline' : 'online';
    if (newStatus !== (data.status ?? 'online')) {
      await docSnap.ref.update({ status: newStatus, statusUpdatedAt: FieldValue.serverTimestamp() });
      updates.push({ id: docSnap.id, newStatus });
    }
  }
  return NextResponse.json({ ok: true, updates });
}
```

Pick the threshold consciously: it is the worst-case window in which customers
can still book online against a site that has gone dark. 2× the cron cadence
is a sane floor.

## 3. Terminals: client failover manager

Framework-free singleton; a thin React provider exposes it. Cloud is always
preferred; the local server is only consulted after the failure threshold.

```ts
export type ClientNetworkMode = 'online' | 'offline' | 'checking';

export interface NetworkState {
  mode: ClientNetworkMode;
  apiBaseUrl: string;             // '' = cloud (same-origin), else local server URL
  lastCheck: Date | null;
  consecutiveFailures: number;
}

const HEARTBEAT_INTERVAL = 5_000;
const FAILURE_THRESHOLD = 3;
const HEALTH_TIMEOUT = 3_000;

// Candidate local-server addresses, tried in order. HTTPS with a self-signed
// CA — devices must have the CA installed (see operations.md) or every
// candidate fails silently from the browser.
const LOCAL_SERVER_FALLBACKS = [
  process.env.NEXT_PUBLIC_LOCAL_SERVER_URL,   // rename to your bundler's env convention
  'https://island.local',
  'https://192.168.1.100',
].filter(Boolean) as string[];

export class NetworkManager {
  private mode: ClientNetworkMode = 'online';
  private apiBaseUrl = '';
  private lastCheck: Date | null = null;
  private consecutiveFailures = 0;
  private timer?: ReturnType<typeof setInterval>;
  private listeners = new Set<(s: NetworkState) => void>();
  private localServerUrl: string | null = null;

  getState(): NetworkState {
    return { mode: this.mode, apiBaseUrl: this.apiBaseUrl, lastCheck: this.lastCheck, consecutiveFailures: this.consecutiveFailures };
  }

  start(intervalMs = HEARTBEAT_INTERVAL): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), intervalMs);
    void this.check();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  subscribe(fn: (s: NetworkState) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    const s = this.getState();
    this.listeners.forEach((fn) => fn(s));
  }

  private async check(): Promise<void> {
    const cloudOk = await this.ping('/api/health');
    this.lastCheck = new Date();

    if (cloudOk) {
      this.consecutiveFailures = 0;
      if (this.mode !== 'online') {
        this.mode = 'online';
        this.apiBaseUrl = '';
        this.notify();
      }
      return;
    }

    this.consecutiveFailures++;
    if (this.consecutiveFailures < FAILURE_THRESHOLD) return;

    // Rescan EVERY tick while offline — the local server may boot, move, or
    // drop after the transition. Scanning only once at the flip means a
    // late-starting local server is never found until the cloud recovers.
    const localUrl = await this.findLocalServer();
    const changed = this.mode !== 'offline' || localUrl !== this.localServerUrl;
    this.mode = 'offline';
    this.localServerUrl = localUrl;
    this.apiBaseUrl = localUrl ?? '';
    if (changed) this.notify();
  }

  private async ping(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async findLocalServer(): Promise<string | null> {
    if (this.localServerUrl && (await this.ping(`${this.localServerUrl}/health`))) {
      return this.localServerUrl;
    }
    for (const url of LOCAL_SERVER_FALLBACKS) {
      if (await this.ping(`${url}/health`)) return url;
    }
    return null;
  }
}

let instance: NetworkManager | null = null;
export function getNetworkManager(): NetworkManager {
  if (!instance) instance = new NetworkManager();
  return instance;
}
```

React wiring (adapt to your framework):

```tsx
'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getNetworkManager, type NetworkState } from './network-manager';

interface NetworkContextValue {
  mode: NetworkState['mode'];
  apiBaseUrl: string;
  isOffline: boolean;
}

const NetworkContext = createContext<NetworkContextValue>({ mode: 'online', apiBaseUrl: '', isOffline: false });

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<NetworkState>(() => getNetworkManager().getState());

  useEffect(() => {
    const manager = getNetworkManager();
    const unsubscribe = manager.subscribe(setState);
    manager.start();
    return () => { unsubscribe(); manager.stop(); };
  }, []);

  return (
    <NetworkContext.Provider value={{ mode: state.mode, apiBaseUrl: state.apiBaseUrl, isOffline: state.mode === 'offline' }}>
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork() { return useContext(NetworkContext); }
```

Every API call in the terminal apps goes through one fetch wrapper that
prefixes `apiBaseUrl` — that single line is the whole failover from the app
code's point of view:

```ts
const fullUrl = apiBaseUrl ? `${apiBaseUrl}${path}` : path;
```

Surface `isOffline` in the terminal UI (banner or indicator) using the host's
own components — staff must be able to tell a customer "we're in island mode,
card payments are unavailable" without calling IT.

## Failure modes this design already survives

| Event | What happens |
|---|---|
| Single dropped health check | Nothing — thresholds absorb it (both sides) |
| Cloud down, local server up | Terminals fail over within ~15 s; site doc goes stale; cron blocks cloud bookings within the stale threshold |
| Cloud down, local server ALSO down | Terminals stay in offline mode with `apiBaseUrl: ''`; requests fail visibly rather than hitting a wrong server |
| Local server reboots mid-outage | Terminals rediscover it on a later rescan tick (hardened behaviour: the earlier implementation scanned only once) |
| Firestore write fails during heartbeat | Client SDK buffers; cron-side staleness is the safety net |
| Flush fails right after reconnect | Retry timer picks it up within a minute ([sync-flush.md](sync-flush.md)) |

## Checklist

- [ ] Both failure thresholds ≥ 3 consecutive checks
- [ ] Cron stale threshold ≥ 2× cron cadence
- [ ] Booking UI subscribes to site status and blocks when offline
- [ ] Client rescans for the local server on every offline tick
- [ ] One fetch wrapper owns `apiBaseUrl` prefixing
- [ ] Island mode visibly indicated in terminal UI
