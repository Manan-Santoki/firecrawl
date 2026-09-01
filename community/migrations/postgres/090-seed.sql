\set ON_ERROR_STOP on

INSERT INTO public.organizations (id, name)
VALUES (:'org_id'::uuid, 'Self-hosted')
ON CONFLICT (id) DO UPDATE SET updated_at = now();

INSERT INTO public.teams (id, name, org_id, banned)
VALUES (:'team_id'::uuid, 'Self-hosted', :'org_id'::uuid, false)
ON CONFLICT (id) DO UPDATE
SET org_id = EXCLUDED.org_id,
    banned = false,
    updated_at = now();

INSERT INTO public.api_keys (key, name, team_id)
VALUES (:'api_key'::uuid, 'Self-hosted API key', :'team_id'::uuid)
ON CONFLICT (key) DO UPDATE
SET team_id = EXCLUDED.team_id,
    name = EXCLUDED.name;

-- Workers require one global row even when the self-host blocklist is empty.
INSERT INTO public.blocklist (data, org_id)
SELECT '{"blocklist":[],"allowedKeywords":[]}'::jsonb, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.blocklist WHERE org_id IS NULL
);
