# The local API surface

The local server mirrors the *subset* of the cloud API that terminals need
during an outage — same paths, same response shapes, so the client failover is
literally a base-URL prefix ([network-failover.md](network-failover.md)).
Resist mirroring more: every endpoint you add is behaviour you must keep
matching the cloud forever.

Reference surface (rename paths to your domain):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | liveness + mode (used by terminals to discover the server) |
| GET | `/status` | none* | replication + collection diagnostics |
| GET | `/api/locations/list` | none | site list (from replica, config fallback) |
| GET | `/api/booking/slots?date&rangeType` | none | availability computed from the replica |
| POST | `/api/kiosk/booking/create` | kiosk key | offline booking |
| GET | `/api/staff/bookings/today` | staff | today's bookings |
| POST | `/api/staff/bookings/check-in` | staff | check-in stamp |
| GET/POST | `/api/staff/inventory*` | staff | stock list / item-out / item-in / adjust / logs |
| GET/POST | `/api/staff/locks*` | staff | list / toggle / emergency / logs |
| GET | `/api/locks/status` | static token | poll endpoint for hardware controllers |
| GET | `/api/pricing/get` | none | price list with stock filtering |
| POST | `/api/staff/auth/login` | staff | login verification (guard does the work) |

\* `/status` exposes counts and error strings; keep it LAN-only via the
firewall, or put it behind staff auth if the LAN is not trusted.

## Health and status

```ts
@Get('health')
getHealth() {
  return {
    ok: true,
    locationId: this.locationId,
    mode: this.networkService.getMode(),
    timestamp: new Date().toISOString(),
  };
}

@Get('status')
async getStatus() {
  const [collections, firestoreCounts] = await Promise.all([
    this.countLocalCollections(),               // replica-side doc counts
    this.replicationService.getFirestoreCounts(), // cloud-side counts (-1 when offline)
  ]);
  return {
    locationId: this.locationId,
    network: this.networkService.getStatus(),
    collections,
    firestoreCounts,       // compare to `collections` to spot replication drift
    replications: this.replicationService.getStatus(),
  };
}
```

The local/cloud count pair is the single most useful ops signal: matching
counts = replica healthy; local zero with cloud nonzero = replication never
completed; `-1` cloud counts = currently offline.

## Availability from the replica

The pattern: capacity comes from replicated config, occupancy from replicated
bookings, and the server derives open hours **from the replicated site
document, never from constants**. (The earlier implementation hardcoded
10:00 to 20:00 and UTC dates; island availability silently diverged from the
website's opening-hours-driven slots. Both fixes are folded in below.)

```ts
export interface SlotAvailability {
  slotId: string;
  timeFrom: string;        // 'HH:00'
  timeTo: string;
  dateTimeFrom: string;    // '<date>THH:00:00'
  availableLanes: number;
  totalLanes: number;
}

export class AvailabilityService {
  constructor(
    private db: { getCollection(name: string): any },
    private locationId: string,
  ) {}

  /** Open-hour range for a date, read from the replicated site doc. */
  private async openHours(date: string): Promise<{ startHour: number; endHour: number }> {
    const site = await this.db.getCollection('locations').findOne(this.locationId).exec();
    const dayName = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const hours = site?.toJSON?.().workingHours?.[dayName] as { from?: string; to?: string } | undefined;
    // Conservative fallback if config is missing — visible, not silent.
    const startHour = hours?.from ? parseInt(hours.from, 10) : 10;
    const endHour = hours?.to ? parseInt(hours.to, 10) : 20;
    return { startHour, endHour };
  }

  async getAvailableSlots(date: string, rangeType: string): Promise<SlotAvailability[]> {
    // 1. Capacity: active slot-type inventory for this station type.
    const inventoryDocs = await this.db.getCollection('inventory')
      .find({ selector: { locationId: this.locationId, type: 'slot', active: true } })
      .exec();
    const matching = inventoryDocs.filter((d: any) => d.toJSON().details?.slotType === rangeType);
    const totalLanes = matching.reduce((sum: number, d: any) => sum + (d.toJSON().details?.capacity ?? 1), 0);
    if (totalLanes === 0) return [];

    // 2. Occupancy: confirmed bookings whose cart slots fall on this date.
    const bookings = await this.db.getCollection('bookings')
      .find({ selector: { locationId: this.locationId, rangeType, status: 'CONFIRMED' } })
      .exec();
    const datePrefix = `${date}T`;
    const occupied = new Map<string, number>();
    for (const b of bookings) {
      for (const slot of b.toJSON().cart?.slots ?? []) {
        if (slot.dateTimeFrom?.startsWith(datePrefix)) {
          occupied.set(slot.time, (occupied.get(slot.time) ?? 0) + 1);
        }
      }
    }

    // 3. Grid from config-driven hours.
    const { startHour, endHour } = await this.openHours(date);
    const result: SlotAvailability[] = [];
    for (let hour = startHour; hour < endHour; hour++) {
      const timeFrom = `${String(hour).padStart(2, '0')}:00`;
      result.push({
        slotId: `local-${date}-${timeFrom}`,
        timeFrom,
        timeTo: `${String(hour + 1).padStart(2, '0')}:00`,
        dateTimeFrom: `${date}T${timeFrom}:00`,
        availableLanes: Math.max(0, totalLanes - (occupied.get(timeFrom) ?? 0)),
        totalLanes,
      });
    }
    return result;
  }
}
```

Dates: treat `date` and slot times as **site-local wall-clock strings**
end-to-end (that is what `dateTimeFrom` prefix-matching assumes). Never derive
"today" from `new Date().toISOString()` — that is UTC and shifts the day
boundary; use the site's IANA timezone from the replicated config:

```ts
export function todayAtSite(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date()); // YYYY-MM-DD
}
```

## Offline booking creation

Serialized through a mutex so two kiosks cannot double-book the last lane —
the replica is process-local, so a process-local mutex is a complete fix.

```ts
import { randomUUID } from 'crypto';
import { Mutex } from 'async-mutex';

const bookingMutex = new Mutex();

export async function createOfflineBooking(deps: {
  availability: AvailabilityService;
  bookings: any;                       // RxCollection
  locationId: string;
}, request: {
  rangeType: string;
  slots: Array<{ time: string; dateTimeFrom: string; lane: string; price: number }>;
  ammunition?: Array<{ price: number; quantity: number; [k: string]: unknown }>;
  contactInfo: { fullName: string; email: string; phone: string };
  source: 'kiosk' | 'walk-in';
  paymentMethod: string;
  currency: string;
}) {
  return bookingMutex.runExclusive(async () => {
    if (request.slots.length > 0) {
      const firstSlot = request.slots[0]!;
      const date = firstSlot.dateTimeFrom.split('T')[0]!;
      const available = await deps.availability.getAvailableSlots(date, request.rangeType);
      for (const slot of request.slots) {
        const timeFrom = slot.time.substring(0, 5);   // normalize '14:00-15:00' → '14:00'
        const info = available.find((a) => a.timeFrom === timeFrom);
        if (!info || info.availableLanes <= 0) {
          throw new Error(`Slot ${slot.time} is not available`);
        }
      }
    }

    const now = new Date().toISOString();
    const slotsTotal = request.slots.reduce((sum, s) => sum + s.price, 0);
    const ammoTotal = (request.ammunition ?? []).reduce((sum, a) => sum + a.price * a.quantity, 0);

    const booking = {
      id: `offline-${randomUUID()}`,          // provenance-visible ID
      rangeType: request.rangeType,
      locationId: deps.locationId,
      pricing: { slotsTotal, ammoTotal, discount: 0, grandTotal: slotsTotal + ammoTotal, currency: request.currency },
      // Offline can't charge cards: COUNTER pays at the desk, others settle on reconnect.
      payment: {
        method: request.paymentMethod,
        status: request.paymentMethod === 'COUNTER' ? 'PENDING_COUNTER_PAYMENT' : 'PENDING',
      },
      cart: {
        slots: request.slots.map((s) => ({ slotId: `offline-slot-${randomUUID()}`, ...s })),
        ammunition: request.ammunition ?? [],
      },
      contactInfo: request.contactInfo,
      source: request.source,
      status: 'CONFIRMED',
      _offlineCreated: true,                  // flush + push-filter marker
      createdAt: now,
      updatedAt: now,
    };
    await deps.bookings.insert(booking);
    return booking;
  });
}
```

## Patching replicated documents

Any offline mutation of a bidirectional document must set the push-filter flag
and bump `updatedAt`:

```ts
await doc.incrementalPatch({
  checkedInAt: new Date().toISOString(),
  checkedInBy: staffUid,
  updatedAt: new Date().toISOString(),
  _locallyModified: true,     // without this, the change never reaches the cloud
});
```

Same shape for lock toggling — patch `status`, then append an audit entry to
the push-only log collection with a client-generated UUID. An
`emergencyLockAll` loop (toggle every unlocked lock + one aggregate log entry
with `lockId: 'ALL'`) is worth shipping for any hardware domain — outages and
emergencies correlate.

## Pricing with stock filtering

When serving a price list from the replica, filter out items whose linked
inventory has no effective stock — the kiosk should not sell ammunition the
site ran out of during the outage. Use `effectiveStock` from
[sync-flush.md](sync-flush.md), not the raw replica `stockLevel`.

## Checklist

- [ ] Every mirrored endpoint's response shape matches the cloud's
- [ ] Availability derives hours from replicated config, not constants
- [ ] All "today"/date logic uses the site timezone, never UTC ISO slicing
- [ ] Booking creation and stock checks serialized with mutexes
- [ ] Offline mutations set `_offlineCreated`/`_locallyModified`
- [ ] Card-payment paths degrade to counter/pending, never fake success
