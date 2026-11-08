-- Homeroll off-chain tables (SPEC §8.7). Paste into Supabase → SQL Editor → Run. Safe to re-run.
--
-- Every table has one shape: (scope, key) → data (jsonb). `scope` is the demo employer account,
-- so each Reset demo starts on empty rows. Only the server touches these tables, with the secret
-- key (SUPABASE_SECRET_KEY), which bypasses row-level security. RLS is on with no policies, so the
-- publishable key and the browser can read or write nothing.
--
-- workers      synthetic name ↔ pseudonymous account of owner-added workers (the only place the
--              link exists, rule R13)
-- invoices     the invoice agent's last result per invoice: checks, grade, model output
-- activity     every chain call the app made, feeds the Activity tab and Rahim's list
-- mock_ledger  mock partner receipts: bKash payout, DuitNow, bank escrow
-- payouts      payout rail quotes and their state (SPEC §8.11), so approval and pay_run batches
--              may run on different server instances
-- payout_nonces each accepted payout intent's nonce, inserted once (R17.2: no replay)
-- relay_claims the relayer's per-worker daily claims and a short lock row (R12 caps); scope 'relay'
-- demo_company which demo company is live, and the Reset demo lock row (§9.6); scope 'ledger'

do $$
declare
  t text;
begin
  foreach t in array array['workers', 'invoices', 'activity', 'mock_ledger',
                        'payouts', 'payout_nonces', 'relay_claims', 'demo_company'] loop
    execute format(
      'create table if not exists public.%I (
         scope text not null,
         key text not null,
         data jsonb not null,
         created_at timestamptz not null default now(),
         primary key (scope, key)
       )', t);
    execute format('create index if not exists %I on public.%I (scope, created_at desc)',
      t || '_scope_created', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;
