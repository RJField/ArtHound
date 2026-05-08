# Payload Dispatch System

## Purpose

Payload dispatch is how ArtHound studios securely share asset data with vendors. A dispatch is an immutable, time-limited snapshot of an asset's fields. The vendor accesses it through their authenticated inbox. The studio can revoke access at any time. Every action on the payload — sent, viewed, mapped, revoked, denied — is recorded in an append-only audit log.

The system is designed to let studios prove, at any later date, exactly what data they shared with whom and when.

## Data model

```
payload_templates       — reusable definitions of which fields a studio exposes outbound
payload_dispatches      — one row per send: immutable snapshot + token hash + expiry/revocation
payload_field_mappings  — recipient's mapping of payload field keys → their own field names
payload_access_log      — append-only audit trail (never updated or deleted)
```

**Schema:** [`migrations/004_payload_dispatch.sql`](../migrations/004_payload_dispatch.sql)

### payload_dispatches

The core row. Key columns:

| Column | Meaning |
|---|---|
| `asset_id` | Canonical asset UUID — survives source-tool migration |
| `sender_studio_id` | Studio that sent the payload |
| `recipient_vendor_id` | Vendor it was sent to (nullable for external/unregistered recipients) |
| `payload_data` | Frozen JSONB snapshot — never updated after creation |
| `expires_at` | Hard expiry — enforced on inbox fetch and access checks |
| `revoked_at` | Set by sender to immediately block all further access |

## Security invariants

**Snapshots are frozen**
- `payload_data` is written once at dispatch time and never modified.
- Recipients read a snapshot of the asset as it was at the moment of dispatch, not a live view of the sender's current data.

**Access checks on every fetch**
- Revocation and expiry are checked on every vendor-inbox fetch and on `POST /{id}/viewed`, `POST /{id}/mapping`, and `POST /{id}/apply`.
- A revoked payload returns `410 Gone`.

**Audit log is append-only**
- `payload_access_log` rows are never updated or deleted.
- Audit failure (DB write error) is intentionally swallowed — it must never block the primary operation, but the failure is logged.

**Scope enforcement**
- Outbox endpoints (`GET /outbox`, `DELETE /dispatch/{id}`) filter on `sender_studio_id = user.studio_id`.
- Inbox endpoints (`GET /vendor-inbox`, `POST /{id}/mapping`) filter on `recipient_vendor_id = user.vendor_id`.
- Audit log endpoint (`GET /{id}/log`) is accessible to sender or recipient only, with an explicit ownership check.

## Lifecycle

```
1. Studio creates a template          POST /api/payloads/templates
   └─ defines which fields to expose: [{key, label, type}]

2. Studio dispatches to a vendor      POST /api/payloads/dispatch-bulk
   ├─ verifies asset belongs to studio (canonical_assets ownership check)
   ├─ builds frozen payload_data snapshot
   ├─ writes payload_dispatches row
   └─ logs 'dispatched' event

3. Vendor fetches inbox               GET /api/payloads/vendor-inbox
   └─ returns active (non-revoked, non-expired) dispatches for this vendor

4. Vendor opens an asset              POST /api/payloads/{id}/viewed
   └─ logs 'viewed' event (studio sees view count in outbox)

5. Vendor maps fields                 POST /api/payloads/{id}/mapping
   ├─ vendor maps payload keys → their own field names
   ├─ upserts payload_field_mappings (idempotent)
   └─ logs 'mapped'

6. Vendor applies mapping             POST /api/payloads/{id}/apply
   ├─ sets applied_at (one-time — 409 if already applied)
   ├─ logs 'applied'
   └─ returns resolved mappings for the caller to act on

7. Studio views audit trail           GET /api/payloads/{id}/log
   └─ returns chronological event log

8. Studio revokes (optional)          DELETE /api/payloads/dispatch/{id}
   ├─ sets revoked_at
   ├─ logs 'revoked'
   └─ payload disappears from vendor inbox immediately
```

## Expiry

- Default expiry: 7 days from dispatch.
- Maximum expiry: 30 days (enforced server-side regardless of what the caller sends).
- Expiry is checked on every access, not just the first redemption.

## Templates

Templates are reusable field definitions that describe what a studio is willing to expose. A template's `field_schema` is an array of `{key, label, type}` objects. When dispatching via `POST /dispatch` (the single-asset, template-based route), the payload data is filtered to only include keys present in the template's `field_schema` — keys outside the template are silently stripped.

The bulk dispatch route (`POST /dispatch-bulk`) currently infers the schema from the keys present in the submitted `asset_data`. It does not require a template. This is intentional for the current workflow where the frontend controls which fields are submitted.

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/payloads/vendors` | studio | List available vendors for dispatch modal |
| `GET` | `/api/payloads/templates` | studio | List this studio's templates |
| `POST` | `/api/payloads/templates` | studio | Create template |
| `PUT` | `/api/payloads/templates/{id}` | studio | Update template |
| `DELETE` | `/api/payloads/templates/{id}` | studio | Delete template |
| `POST` | `/api/payloads/dispatch` | studio | Single-asset dispatch (template-based) |
| `POST` | `/api/payloads/dispatch-bulk` | studio | Multi-asset dispatch |
| `GET` | `/api/payloads/outbox` | studio | Sent dispatches with view counts |
| `DELETE` | `/api/payloads/dispatch/{id}` | studio | Revoke dispatch |
| `GET` | `/api/payloads/vendor-inbox` | vendor | Received dispatches (active only) |
| `POST` | `/api/payloads/{id}/viewed` | vendor | Record a view event |
| `POST` | `/api/payloads/{id}/mapping` | vendor | Save field mapping |
| `POST` | `/api/payloads/{id}/apply` | vendor | Apply mapping |
| `GET` | `/api/payloads/{id}/log` | studio or vendor | Read audit log |

**Implementation:** [`routes/payload.py`](../routes/payload.py)
