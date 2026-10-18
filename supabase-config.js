/* Shared database settings. Left empty in the repo so local runs and
   tests stay offline: the build (scripts/build.js) writes the team project, or
   the SUPABASE_URL and SUPABASE_ANON_KEY environment variables.
   Only a public anon/publishable key may appear here, never service_role. */
window.SUPABASE_CONFIG = { url: '', anonKey: '' };
