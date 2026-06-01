# Asset Reviews

_Last updated: 2026-05-11_

Reviews are ArtHound-native structured feedback records attached to canonical assets. They are not synced to or from any source tool, they exist only in ArtHound's database. Both studios and vendors can create reviews on assets they have access to, and reviews support file attachments stored in Supabase Storage.

---

## Concepts

**Review**: a titled, described, status-bearing record attached to a canonical asset. Created by a user of either org type. Has its own lifecycle independent of any source tool record.

**Author org**: the org that created the review, identified by `author_org_type` (`studio` or `vendor`) + `author_org_id`. This pair controls who can edit or delete the review.

**Status**: a free-text field with conventional values: `pending`, `in_review`, `approved`, `changes_requested`. Not validated by the API, studios and vendors can use any status label.

**Review attachment**: a file uploaded directly to a review (distinct from asset attachments that come from the source tool). Stored at `attachments/reviews/{review_id}/{uuid}_{filename}` in Supabase Storage. Only the uploader can delete their own attachments.

---

## Access Rules

**Studios** can review any asset in their own org's `canonical_assets`.

**Vendors** can review assets they have received via a non-revoked payload dispatch. The review creation endpoint checks `payload_dispatches` to verify the vendor has an active dispatch for that asset.

**Editing and deletion** are scoped to the creating org: `author_org_type + author_org_id` must match the caller's identity. Individual attachment deletion is additionally scoped to the uploading user's email.

---

## Review Lifecycle

```
POST /api/reviews           → create review (studio or vendor)
GET  /api/reviews           → list reviews (optionally filter by canonicalAssetId)
GET  /api/reviews/{id}      → single review with asset metadata
PATCH /api/reviews/{id}     → update title, description, status
DELETE /api/reviews/{id}    → delete review (creator org only)

POST /api/reviews/{id}/attachments              → upload file
GET  /api/reviews/{id}/attachments              → list attachments (metadata only)
GET  /api/reviews/{id}/attachments/{aid}/content → stream file
DELETE /api/reviews/{id}/attachments/{aid}      → delete (uploader only)
```

File uploads are limited to 100 MB. Files are stored to Supabase Storage and their metadata (filename, storage path, content type, file size, uploader email) is recorded in `review_attachments`.

---

## Database Schema

### `asset_reviews`

```
id                  uuid PK
studio_id           uuid → studios (the studio that owns the asset)
canonical_asset_id  uuid → canonical_assets
author_org_type     text (studio | vendor)
author_org_id       uuid
title               text
description         text
status              text
created_by_email    text NOT NULL
created_at          timestamptz
```

RLS:
- Studio members can select, insert, and update reviews where `studio_id` matches their studio
- Only the creator (matched by `created_by_email`) can delete

### `review_attachments`

```
id              uuid PK
review_id       uuid → asset_reviews (ON DELETE CASCADE)
studio_id       uuid → studios
author_org_type text (studio | vendor)
author_org_id   uuid
filename        text NOT NULL
storage_path    text NOT NULL
content_type    text
file_size       bigint
uploaded_by     text NOT NULL   (email)
created_at      timestamptz
```

RLS:
- Studio members can select attachments where `studio_id` matches
- Vendor members can select attachments where `author_org_type = vendor` and `author_org_id` matches their vendor
- Only the uploader can delete (matched by `uploaded_by` email)

---

## Frontend Components

Reviews are surfaced in the Asset Viewer's Reviews tab (`frontend/src/components/assets/tabs/ReviewsTab.jsx`).

The tab has two distinct sections:

**Asset Attachments**: a read-only gallery of files that came from the source tool (Airtable/Jira fields), shown at the top as a collapsible section. These use the asset attachment proxy endpoint, not the review attachment endpoint.

**Reviews section**: lists all reviews for the asset with a count badge. Includes a collapsible `NewReviewForm` for creating reviews inline.

### `ReviewCard`

Each review renders as a collapsible card showing: title, status badge, creator email, creation date, and (when expanded) full description and `ReviewAttachments`.

Status badge colours:
- `pending`, gray
- `approved`, green
- `in_review`, accent (blue)
- `changes_requested` / `rejected`, red

### `ReviewAttachments`

Inline attachment widget within a review card. Supports:
- Drag-and-drop multi-file upload (each file sent individually)
- Delete button per file (uploader only)
- Gallery rendering via the shared `AttachmentGallery` → `MediaLightbox` viewer chain (same as source tool attachments)

---

## Relationship to the Handshake

The studio↔vendor handshake includes a `review_collaboration_mode` field (`none` / `isolated` / `collaborative`) agreed at invite time. Currently only `none` (simple delivery, each org sees only their own reviews) is implemented. `isolated` and `collaborative` modes,  modes, where studios share reviews with vendors and/or reviews are jointly visible, are schema-stubbed but not yet built.

See [Handshake, Design Decisions](handshake.md) for the rationale behind setting review mode at invite time.

---

## Known Gaps

**Cross-org review visibility**: studios cannot currently share reviews with vendors and vendors cannot see studio reviews on a dispatched asset. The `review_collaboration_mode` flag on the link record provides the intended control surface, but the RLS and UI for sharing are not yet implemented.

**Review field visibility customization**: the metadata shown alongside a review in the detail panel is filtered heuristically. There is no per-studio configuration for which asset meta fields appear in the review context.

**No notification on new review**: reviewers receive no in-app or email notification when a new review is posted on an asset they are watching.
