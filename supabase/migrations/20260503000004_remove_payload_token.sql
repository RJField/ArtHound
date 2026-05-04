-- Remove the unused token-based redemption path from payload_dispatches.
-- All vendor access goes through the authenticated vendor-inbox endpoint.
-- token_hash and received_at were only meaningful for the public /receive/{token} route.
alter table payload_dispatches drop column token_hash;
alter table payload_dispatches drop column received_at;
