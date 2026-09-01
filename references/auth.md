# Local API auth

Four client classes hit the local server, each with its own scheme. One guard
dispatches on route metadata.

| Client | Scheme | Credential | Notes |
|---|---|---|---|
| Staff PWA | `Authorization: Bearer <IdP ID token>` | Firebase ID token | Verified online; replica-checked offline |
| Kiosk PWA | `X-Kiosk-Api-Key` header (or `?apiKey=`) | static key | Optional — empty key = open kiosk endpoints |
| Hardware (lock controllers) | `Authorization: HMAC id:ts:sig` | shared secret | Replay-protected, timing-safe |
| Hardware (simple pollers) | `?token=` or `x-access-token` | static token | For devices that can't do HMAC |

All secrets are mirrored env vars — the same value on the cloud and the local
server, so terminals authenticate identically in both modes.

## Staff auth: online-verify, offline-lookup

The heart of island-mode auth. Online, the ID token is cryptographically
verified by the admin SDK. Offline, verification is impossible (no IdP
reachable), so the server falls back to decoding the token and checking the
uid against the replicated staff directory.

**The fallback must be gated on actually being offline.** If it runs whenever
`verifyIdToken` throws, a *forged* token rejected online falls through to the
lenient path and is accepted — signature verification is then never enforced
at all. This was a live bug in the earlier implementation.

The offline path is an accepted trade-off, not a hole, because: the LAN is
physically on-site, TLS-only, the staff directory is the allow-list, and role
checks still apply. Cheap hardening kept in the template: reject expired
tokens even offline.

```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as admin from 'firebase-admin';
import { verifyHmac } from './hmac.util';

export const AUTH_TYPE_KEY = 'auth_type';
export const MIN_ROLE_KEY = 'min_role';
export type AuthType = 'staff' | 'hmac' | 'token' | 'kiosk';
export type StaffRole = 'operator' | 'manager' | 'admin';

const ROLE_HIERARCHY: Record<StaffRole, number> = { operator: 1, manager: 2, admin: 3 };

interface GuardDeps {
  getStaff(uid: string): Promise<{ uid: string; displayName: string; email: string; role: StaffRole; locationIds: string[]; active: boolean } | null>;
  isOffline(): boolean;             // from NetworkService.getMode()
  locationId: string;
  terminalSecret: string;
  lockAccessToken: string;
  kioskApiKey: string;              // '' = kiosk endpoints open
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private deps: GuardDeps) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const authType =
      this.reflector.get<AuthType>(AUTH_TYPE_KEY, context.getHandler()) ??
      this.reflector.get<AuthType>(AUTH_TYPE_KEY, context.getClass()) ??
      'staff';
    const request = context.switchToHttp().getRequest();

    switch (authType) {
      case 'hmac': {
        const header = request.headers.authorization;
        if (!header) throw new UnauthorizedException('Missing Authorization header');
        const result = verifyHmac(header, this.deps.terminalSecret);
        if (!result.valid) throw new UnauthorizedException(result.error);
        request.terminalId = result.terminalId;
        return true;
      }
      case 'token': {
        const token = request.query?.token || request.headers['x-access-token'];
        if (!token || token !== this.deps.lockAccessToken) {
          throw new UnauthorizedException('Invalid access token');
        }
        return true;
      }
      case 'kiosk': {
        if (!this.deps.kioskApiKey) return true;
        const provided = request.headers['x-kiosk-api-key'] || request.query?.apiKey;
        if (provided !== this.deps.kioskApiKey) throw new UnauthorizedException('Invalid kiosk API key');
        return true;
      }
      default:
        return this.verifyStaff(request, context);
    }
  }

  private async verifyStaff(request: any, context: ExecutionContext): Promise<boolean> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing Bearer token');
    const token = header.slice(7);

    let uid: string;
    try {
      uid = (await admin.auth().verifyIdToken(token)).uid;
    } catch {
      // Lenient decode ONLY while the IdP is unreachable. Online, a failed
      // verification is a failed verification.
      if (!this.deps.isOffline()) throw new UnauthorizedException('Invalid token');
      uid = decodeOfflineToken(token);
    }

    const staff = await this.deps.getStaff(uid);
    if (!staff || !staff.active) throw new UnauthorizedException('Staff member not found or inactive');

    const minRole = this.reflector.get<StaffRole>(MIN_ROLE_KEY, context.getHandler());
    if (minRole && ROLE_HIERARCHY[staff.role] < ROLE_HIERARCHY[minRole]) {
      throw new ForbiddenException(`Requires ${minRole} role, you have ${staff.role}`);
    }
    if (!staff.locationIds.includes(this.deps.locationId)) {
      throw new ForbiddenException('No access to this location');
    }

    request.staff = { uid: staff.uid, displayName: staff.displayName, email: staff.email, role: staff.role };
    return true;
  }
}

/** Unverified decode for island mode: structure + expiry checks only. */
export function decodeOfflineToken(token: string): string {
  let payload: { user_id?: string; sub?: string; exp?: number };
  try {
    const part = token.split('.')[1];
    if (!part) throw new Error('malformed');
    payload = JSON.parse(Buffer.from(part, 'base64').toString());
  } catch {
    throw new UnauthorizedException('Invalid token');
  }
  // Expiry still holds offline — a token stolen last month stays dead.
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
    throw new UnauthorizedException('Token expired');
  }
  const uid = payload.user_id || payload.sub;
  if (!uid) throw new UnauthorizedException('Invalid token');
  return uid;
}
```

`getStaff` reads the replicated staff collection
([replication.md](replication.md)) — which means offline login only works for
staff whose directory entries replicated *before* the outage. Onboarding a new
staff member during an outage is impossible by design.

Usage on a route:

```ts
@Post('api/staff/locks/toggle')
@UseGuards(AuthGuard)
@SetMetadata(AUTH_TYPE_KEY, 'staff')
@SetMetadata(MIN_ROLE_KEY, 'operator')
async toggle(@Req() req: any, @Body() body: ToggleBody) { /* req.staff is set */ }
```

## Hardware HMAC

For lock/gate controllers that can compute a MAC. Stateless, replay-protected,
constant-time comparison.

Header format: `Authorization: HMAC <terminalId>:<timestampMs>:<signature>`
where `signature = HMAC-SHA256(terminalId + timestampMs, TERMINAL_SECRET)` hex.

```ts
import { createHmac, timingSafeEqual } from 'crypto';

const REPLAY_WINDOW_MS = 30_000;   // |now - ts| beyond this = rejected

export function generateHmac(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyHmac(
  authHeader: string,
  secret: string,
): { valid: boolean; terminalId?: string; error?: string } {
  if (!authHeader.startsWith('HMAC ')) return { valid: false, error: 'Invalid auth scheme' };

  const parts = authHeader.slice(5).split(':');
  if (parts.length !== 3) return { valid: false, error: 'Invalid HMAC format' };
  const [terminalId, timestampStr, signature] = parts as [string, string, string];

  const timestamp = parseInt(timestampStr, 10);
  if (Number.isNaN(timestamp) || Math.abs(Date.now() - timestamp) > REPLAY_WINDOW_MS) {
    return { valid: false, error: 'Request expired (replay protection)' };
  }

  const expected = generateHmac(`${terminalId}${timestampStr}`, secret);
  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    return { valid: false, error: 'Invalid signature' };
  }
  return { valid: true, terminalId };
}
```

Known limitations, accepted for on-site hardware on a private LAN: the secret
is fleet-wide (one compromised controller = rotate everywhere), the signature
does not cover the request body, and within the 30 s window an intercepted
request could be replayed — TLS on the LAN is what actually prevents
interception ([operations.md](operations.md)). If your hardware can hold
per-device secrets, upgrade to per-device keys with the same verify shape.

## Seam notes

- Swapping the IdP (Clerk, Supabase, custom JWT) touches only `verifyIdToken`
  + `decodeOfflineToken`; keep the online-verify/offline-lookup split and the
  offline gate.
- The role hierarchy is a plain ordered map — replace roles, keep the
  comparison.
- Not NestJS? The guard is one function of
  `(headers, query, routeMeta) → principal | throw`; port it as middleware.

## Checklist

- [ ] Offline decode reachable ONLY when the network monitor says offline
- [ ] Expiry checked even on the offline path
- [ ] Staff must exist, be active, and belong to this site
- [ ] HMAC compare is timing-safe and length-guarded
- [ ] All secrets mirrored between cloud and local env
- [ ] Empty kiosk key documented as "open" and intended
