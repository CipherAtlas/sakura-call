# TODO

- Revisit Cloudflare Realtime TURN once account/API access is sorted out.
  - Current state: a valid Cloudflare API token verifies successfully, but the `GET /accounts/{account_id}/calls/turn_keys` endpoint still returns `403 Authorization Failure` even with Calls Read/Edit shown in the dashboard.
  - Preferred future path: create a Cloudflare TURN key, store server-only TURN key credentials, and generate short-lived ICE server credentials from the backend instead of shipping static TURN credentials to the browser.
