# Deployment Web API

Enable the API in **Settings → Web API**. It is off by default and only runs while Luna Remote is open. By default it listens on `127.0.0.1:39647`. Select **This and other devices** to accept connections through the machine's network interfaces, then use its IP address when calling it remotely.

Use **View API endpoints** in the same settings page to browse each request and response format, or copy one endpoint or the complete reference.

Every request needs `Authorization: Bearer <token>`. Copy the token from Settings. The token is stored in the operating system credential store. Browser requests from any origin are supported; the Bearer token controls access. Use an HTTPS reverse proxy for browser calls from an HTTPS site and when the API is reachable beyond a trusted LAN.

Base URL: `http://<app-machine>:<port>/api/v1`

| Method | Path | Result |
| --- | --- | --- |
| GET | `/deployments` | Task summaries in `{ "items": [...] }`; optional `?bookmarkId=<id>` |
| GET | `/deployments/{id}` | Saved task details |
| GET | `/deployments/{id}/runs` | `{ "items": [...] }`, newest first, up to 500 records |
| GET | `/runs` | Recent runs across all tasks, newest first, up to 500 records |
| GET | `/runs/{id}` | Full run record, including status, timestamps, output, and error |
| POST | `/deployments/{id}/runs` | `202 Accepted` with `{ "runId": "...", "statusUrl": "/api/v1/runs/..." }` |

The POST starts an asynchronous run. Poll `GET /runs/{runId}` until `status` is `succeeded`, `failed`, or `cancelled`. API runs have `triggerType: "api"` and do not stop for the desktop manual-confirmation prompt. They reuse an existing connected SSH session for the task's machine. If no session is connected, unattended reconnection requires saved credentials and a trusted host key. The app must remain open while a run is active.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:39647/api/v1/deployments"

curl -X POST -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:39647/api/v1/deployments/TASK_ID/runs"
```

Errors use an HTTP status and `{ "error": "..." }`. Disabling the API in Settings stops the listener. Regenerating the token invalidates the previous token immediately.
