# Quality Check SaaS Platform

Enterprise-grade multi-tenant QC SaaS (Next.js App Router + Firebase Functions + Firestore).

## Monorepo layout

- `apps/web` - Next.js frontend (Vercel)
- `apps/functions` - Firebase Cloud Functions (Node.js + TypeScript)
- `packages/qc-engine` - deterministic QC rule engine (shared)
- `packages/shared` - shared types (tenancy, RBAC, audit)

## Local development

### Prereqs

- Node.js 20+
- Firebase CLI (`npm i -g firebase-tools`) or use repo script

### Install

```bash
npm install
```

### Run Next.js

```bash
npm run dev
```

### Run Firebase emulators

```bash
npm run emulators
```

> Note: `demo-qc` is a placeholder Firebase project id; update `.firebaserc` for real environments.
