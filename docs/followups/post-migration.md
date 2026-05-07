# Post-migration follow-ups

Tracking work that was deferred from the ADK migration (Phases 1–12,
2026-04-29). None of these block production cut-over for an internal
demo, but each should be revisited before broader release.

## Operational

- [ ] **Deploy target decision** — Vertex AI Agent Engine vs Cloud Run.
      Spec § 8 left this open. Affects whether `SESSION_BACKEND=vertex` is
      wired and whether the Cloud Run callback sidecar from the reference
      project is needed.
- [ ] **Run the parity check** (`scripts/migration-parity-check.py`).
      Needs both legacy `sap-service` (now deleted from this repo —
      check out the prior commit `822a49f^` to get it back) and the new
      ADK agent online with valid SAP credentials. Manual one-shot.
- [ ] **Run E2E** (`pnpm e2e`). Needs `E2E_SAP_PASSWORD` set and the
      stack live. CI without creds runs only E3 (the auth-gate).

## Production hardening

- [ ] **Secret Manager token persistence** for OAuth — currently the SAP
      access/refresh token lives only in `tool_context.state` (in-memory
      ADK session). Production deployments behind multiple workers will
      lose the token on container restart / cross-worker routing. Port
      `_save_token_to_secret` / `_load_token_from_secret` from the
      reference project (`sap-gemini-enterprise/sap_agent/agent.py:200+`)
      when GCP project is provisioned.
- [ ] **HMR-aware singleton hardening** for `db.ts` / `logger.ts` /
      `gemini.ts` / `gcs.ts` — see CLAUDE.md. Long dev sessions accumulate
      postgres pools and write streams.
- [ ] **ADK `/run` envelope parser** — `src/app/api/sap/auth/route.ts`
      and `src/app/api/sap/oauth/callback/route.ts` currently probe the
      response payload via substring/regex (`raw.includes('"success":true')`,
      `/login_url"\s*:\s*"([^"]+)"/`). Replace with a typed parser over
      the documented event/part shape.
- [ ] **Reverse proxy integration** — Next.js (3000) and ADK (8200) are
      separate origins in dev. Production should serve both behind one
      domain to avoid CORS overhead and simplify cookie scoping.

## Pre-existing test failure (not caused by migration)

- [ ] `src/app/api/pipeline/start/__tests__/route.test.ts` — failing
      with `TypeError: ... is not a constructor` from a `@google-cloud/storage`
      mock. Predates Phase 11; isolate and fix or delete.

## Product

- [ ] **services.yaml admin UI** — currently file-edit only. Adding
      services requires editing `adk_agent/services.yaml` and restarting
      the agent.
- [ ] **OAuth popup origin validation** —
      `src/app/api/sap/oauth/callback/route.ts` posts to the opener with
      `targetOrigin: '*'`. Tighten to the configured app origin once the
      production domain is known.
