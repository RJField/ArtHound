# Platform Admin

_Last updated: 2026-05-14_

The platform admin system provides ArtHound operators with system-wide controls that apply across all organisations. Access is restricted to a fixed list of email addresses configured at deploy time.

---

## Access

Platform admin access is controlled by the `PLATFORM_ADMIN_EMAILS` environment variable, a comma-separated list of email addresses. Any authenticated user whose email matches an entry in this list has platform admin access. Users not in the list get a 403 on all admin routes.

This is separate from org-level roles (`owner`, `admin`, `user`). A platform admin does not need to be a member of any studio or vendor org.

The platform admin panel is at `/admin` in the app and renders `AdminPanel.jsx`. The link is only visible to users who pass the email check.

---

## System Settings

A single-row `system_settings` table stores global configuration. Platform admins read and update it via:

- `GET /api/admin/settings`, returns current settings
- `PATCH /api/admin/settings`, update one or more fields

### `registration_invite_required`

Boolean. When `true`, new users signing up via the public signup form must provide a platform-level invite code (`registration_invite_code`) before their account can be created. This is the global signup gate, distinct from the org-level invite code system (which controls joining an existing org).

When `false`, anyone with the ArtHound URL can create an account.

### `registration_invite_code`

A string code that new users must enter when `registration_invite_required` is `true`. Set to any value you like. Clear it (set to empty string or null) to remove the gate without disabling the requirement flag.

---

## Admin Panel UI

`AdminPanel.jsx` presents a simple settings form:

- **Registration gate toggle**: a switch to enable/disable `registration_invite_required`
- **Invite code field**: a text input for `registration_invite_code`
- **Save button**: calls `PATCH /api/admin/settings`

Changes take effect immediately on save. There is no cache layer on system settings.

---

## API Reference

All endpoints are under `/api/admin`. Restricted to `PLATFORM_ADMIN_EMAILS`.

| Method | Path | Description |
|---|---|---|
| GET | `/settings` | Read current system settings |
| PATCH | `/settings` | Update one or more settings fields |

### `PATCH /api/admin/settings` body

```json
{
  "registration_invite_required": true,
  "registration_invite_code": "LAUNCH2026"
}
```

Both fields are optional in each request. Omitted fields are not changed. Sending an empty object returns 422.

### Response

```json
{
  "registration_invite_required": true,
  "registration_invite_code": "LAUNCH2026",
  "updated_at": "2026-05-14T10:00:00Z",
  "updated_by": "user-uuid"
}
```

---

## Database Schema

### `system_settings`

```
id                           boolean PK DEFAULT true   (enforces single row)
registration_invite_required boolean NOT NULL DEFAULT false
registration_invite_code     text
updated_at                   timestamptz
updated_by                   uuid → auth.users
```

The single-row pattern uses a `boolean` PK constrained to `true`, only one row can ever exist. `updated_at` is maintained by a DB trigger.

---

## Known Gaps

**No audit log**: settings changes record only `updated_by` and `updated_at`. There is no history of what values were set before a change.

**Email-based access only**: platform admin access cannot be granted via a role or flag in the DB. It requires a deploy-time config change to `PLATFORM_ADMIN_EMAILS`. Adding or removing platform admins requires a redeploy.

**No email notification on admin access**: there is no alert when a platform admin logs in or changes settings.
