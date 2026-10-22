# Training Calendar

Two staff training tools for the marina, built as Claude artifacts.

| App | File | What it does |
| --- | --- | --- |
| Training Register | `apps/training-register.html` | Staff directory, courses, training matrix, calendar with planned training and drills (drag to reschedule), 30/60/90-day expiry alerts, reminders, compliance reports, document uploads, manager and staff roles. |
| Dockside Training | `apps/dockside-training.html` | Shared calendar of training sessions with booking and attendance marking. |

## How they run

These are the source files of pages published as Claude artifacts. They use the artifact runtime
(`window.claude.use("db")`, `"user"`, `"assets"` and `"downloads"`) for shared data, sign-in, file
uploads and downloads. Opened as a plain file in a browser they load but show a "live data is not
available" notice, because the runtime is not there.

To change one, edit the file here and republish it as the same artifact, declaring the capabilities
below.

### Training Register capabilities

```json
{
  "db": { "rules": [
    { "path": "staff", "read": "admin", "write": "admin" },
    { "path": "staff/{self}", "read": "view", "write": "admin" },
    { "path": "training", "read": "admin", "write": "admin" },
    { "path": "training/{self}", "read": "view", "write": "admin" },
    { "path": "courses", "read": "view", "write": "admin" },
    { "path": "plans", "read": "view", "write": "admin" }
  ] },
  "user": { "scopes": ["profile"] },
  "assets": {},
  "downloads": true
}
```

Managers need Editor access to the artifact. Staff need Contributor access. Each staff member is linked
to their own login so they see only their own records.

### Dockside Training capabilities

```json
{
  "db": { "rules": [ { "path": "sessions", "read": "view", "write": "admin" } ] },
  "user": { "scopes": ["profile"] },
  "downloads": true
}
```

## Data

Both apps keep their data in the artifact database, not in this repository.
