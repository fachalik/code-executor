# code-executor

Sandboxed code execution playground.

**Stack:** React + Monaco Editor + shadcn/ui · Express + TypeScript · Piston

---

## Quick start

```bash
docker compose up --build
```

| Service  | URL                   |
|----------|-----------------------|
| Frontend | http://localhost:5173 |
| Backend  | http://localhost:3001 |
| Piston   | http://localhost:2000 |

### Install language runtimes into Piston

Piston ships empty — install runtimes after first boot:

```bash
docker compose exec piston ppman install javascript
docker compose exec piston ppman install python
docker compose exec piston ppman install typescript
```

Verify what's installed (this is the config the backend targets):

```bash
curl -s http://localhost:2000/api/v2/runtimes | jq .
```

```json
[
  { "language": "javascript", "version": "20.11.1", "runtime": "node",
    "aliases": ["node-javascript", "node-js", "javascript", "js"] },
  { "language": "python", "version": "3.12.0",
    "aliases": ["py", "py3", "python3", "python3.12"] },
  { "language": "typescript", "version": "5.0.3",
    "aliases": ["ts", "node-ts", "tsc", "typescript5", "ts5"] }
]
```

The versions in [backend/src/engines/piston.ts](backend/src/engines/piston.ts) are pinned to
match. If you install different versions, update `PISTON_LANG` there.

---

## Local development

```bash
# Backend
cd backend
npm install
PISTON_URL=http://localhost:2000 npm run dev   # :3001

# Frontend (separate terminal)
cd frontend
npm install
npm run dev   # :5173 — proxies /api → :3001
```

---

## Security model

| Layer | Mechanism |
|-------|-----------|
| **Frontend** | Monaco configured to show type errors on `fetch` / `XMLHttpRequest` |
| **Backend sanitizer** | Regex pre-flight rejects `fetch()`, `require(pkg)`, `import pkg`, `XMLHttpRequest`, `child_process`, etc. |
| **Piston runtime** | nsjail — network interface disabled, separate PID/mount namespace, ephemeral `/piston/jobs/<id>` dir |

> `require()` for built-in Node modules (`path`, `os`, `crypto`, etc.) is allowed —
> the sanitizer only blocks third-party package imports (patterns without `./` or `/`).

---

## Project structure

```
code-executor/
├── docker-compose.yml          # Piston + backend + frontend
├── backend/
│   ├── src/
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── routes/execute.ts   # POST /api/execute
│   │   ├── engines/
│   │   │   └── piston.ts
│   │   └── middleware/
│   │       └── sanitize.ts     # code pre-flight checks
│   └── Dockerfile
└── frontend/
    ├── src/
    │   ├── App.tsx
    │   ├── components/
    │   │   ├── CodeEditor.tsx  # Monaco wrapper
    │   │   ├── OutputPanel.tsx
    │   │   └── ui/             # shadcn components
    │   ├── hooks/useExecutor.ts
    │   └── types/index.ts      # Language configs + default code
    └── Dockerfile
```

## API

### `POST /api/execute`

```json
{
  "code":     "console.log('hello')",
  "language": "javascript"
}
```

**Response (success)**
```json
{
  "ok":       true,
  "stdout":   "hello\n",
  "stderr":   "",
  "exitCode": 0,
  "signal":   null,
  "engine":   "piston",
  "language": "javascript"
}
```

**Response (blocked)**
```json
{
  "error":   "Blocked pattern detected: \"fetch()\"",
  "hint":    "Network access is disabled. Remove fetch() calls.",
  "blocked": "fetch()"
}
```

### `GET /api/languages`

```json
{ "languages": ["javascript", "typescript", "python"], "engine": "piston" }
```

Supported languages: `javascript` (Node 20.11.1) · `typescript` (tsc 5.0.3) · `python` (3.12.0)
