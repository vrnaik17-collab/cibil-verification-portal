# CIBIL Verification Portal via Proxy Agent

This repository houses a vanilla HTML5 application alongside a secure Supabase Edge Function to bridge direct client-side integration tasks onto an abstract backend environment safely.

## CLI Commands Reference

```bash
# Link live platform variables
supabase link --project-ref your-supabase-project-id

# Push service keys securely to execution runtime
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="your-role-token-string"

# Deploy Edge environment
supabase functions deploy urbanmoney-proxy
