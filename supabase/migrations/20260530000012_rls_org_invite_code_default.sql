-- 20260530000012_rls_org_invite_code_default.sql
-- RLS migration 12 — give studios/vendors.invite_code a DB default (plan §4a item 3, signup Option C).
--
-- The bootstrap org-creation RPCs (rpc_create_studio_with_owner / rpc_create_vendor_with_owner,
-- migration 4) insert ONLY (name) — they were authored before anything called them. invite_code is
-- NOT NULL with no default (migration 20260511000001), so the FIRST caller (the Option C post-login
-- onboarding create path) would hit a not-null violation. A column DEFAULT fixes it for the RPC path
-- and any other insert without coupling the fix to the RPC body. generate_invite_code() is
-- PUBLIC-executable, so the SECURITY DEFINER RPC owner (arthound_rpc) can evaluate the default.
--
-- The legacy signup path keeps passing invite_code explicitly (that value overrides the default) —
-- unchanged. Additive + idempotent (ALTER ... SET DEFAULT is a no-op if already set to this).

begin;

alter table public.studios alter column invite_code set default public.generate_invite_code();
alter table public.vendors  alter column invite_code set default public.generate_invite_code();

commit;

-- ── Post-apply test ───────────────────────────────────────────────────────────────────────────────
--   begin;
--     insert into public.studios (name) values ('__invite_default_probe__') returning invite_code; -- 8-char, non-null
--   rollback;
