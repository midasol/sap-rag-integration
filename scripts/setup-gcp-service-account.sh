#!/usr/bin/env bash
#
# Automated GCP setup for this project.
#
# Creates (or reuses) a service account, grants Storage Object Admin,
# creates the GCS bucket if missing, generates a JSON key, and writes
# the resulting values into .env.local.
#
# Requirements:
#   - gcloud CLI installed: https://cloud.google.com/sdk/docs/install
#   - Authenticated: gcloud auth login
#
# Usage:
#   bash scripts/setup-gcp-service-account.sh
#   pnpm gcp:setup
#
# Re-running with the same inputs is safe (idempotent).
#
# Override defaults via env vars:
#   GCP_SA_NAME          (default: gemini-rag-storage)
#   GCP_KEY_FILE         (default: ./service-account.json)
#   GCP_BUCKET_LOCATION  (default: us)

set -euo pipefail

# ---- defaults ---------------------------------------------------------------
SA_NAME="${GCP_SA_NAME:-gemini-rag-storage}"
SA_DISPLAY_NAME="Gemini RAG Storage"
KEY_FILE="${GCP_KEY_FILE:-./service-account.json}"
BUCKET_LOCATION="${GCP_BUCKET_LOCATION:-us}"
ENV_FILE=".env.local"
ROLE="roles/storage.objectAdmin"

# ---- helpers ----------------------------------------------------------------
log()  { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }

read_env() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^${key}=" "$ENV_FILE" | head -1 | sed -E "s/^${key}=//" || true
}

write_env() {
  local key="$1" value="$2"
  if [ ! -f "$ENV_FILE" ]; then
    if [ -f .env.local.example ]; then
      cp .env.local.example "$ENV_FILE"
    else
      : > "$ENV_FILE"
    fi
  fi
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # macOS/BSD sed needs the backup-file argument; remove it after.
    sed -i.bak -E "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    rm -f "${ENV_FILE}.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

# ---- preflight --------------------------------------------------------------
if ! command -v gcloud >/dev/null 2>&1; then
  err "gcloud CLI not found."
  err "Install: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1 || true)"
if [ -z "$ACTIVE_ACCOUNT" ]; then
  err "Not authenticated to gcloud."
  err "Run: gcloud auth login"
  exit 1
fi
log "Authenticated as $ACTIVE_ACCOUNT"

# ---- collect inputs ---------------------------------------------------------
PROJECT_ID="$(read_env GCS_PROJECT_ID)"
if [ -z "${PROJECT_ID:-}" ]; then
  PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
fi
if [ -z "${PROJECT_ID:-}" ]; then
  read -r -p "GCP Project ID: " PROJECT_ID
fi
if [ -z "${PROJECT_ID:-}" ]; then
  err "Project ID is required."
  exit 1
fi
log "Project: $PROJECT_ID"

BUCKET_NAME="$(read_env GCS_BUCKET_NAME)"
if [ -z "${BUCKET_NAME:-}" ]; then
  read -r -p "GCS bucket name (will be created if missing): " BUCKET_NAME
fi
if [ -z "${BUCKET_NAME:-}" ]; then
  err "Bucket name is required."
  exit 1
fi
log "Bucket: gs://${BUCKET_NAME}"

# ---- enable required APIs ---------------------------------------------------
log "Enabling required APIs (iam.googleapis.com, storage.googleapis.com)"
gcloud services enable iam.googleapis.com storage.googleapis.com \
  --project "$PROJECT_ID" \
  --quiet

# ---- create service account -------------------------------------------------
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
if gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  log "Service account already exists: $SA_EMAIL"
else
  log "Creating service account: $SA_EMAIL"
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="$SA_DISPLAY_NAME" \
    --project "$PROJECT_ID"
fi

# ---- grant role -------------------------------------------------------------
# IAM has eventual consistency: a freshly-created service account may briefly
# 404 when used in a policy binding. Retry with backoff.
log "Granting $ROLE to $SA_EMAIL"
attempts=0
max_attempts=6
until gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:${SA_EMAIL}" \
        --role="$ROLE" \
        --condition=None \
        --quiet >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge "$max_attempts" ]; then
    err "IAM binding failed after $max_attempts attempts."
    err "Run manually: gcloud projects add-iam-policy-binding $PROJECT_ID \\"
    err "  --member=serviceAccount:${SA_EMAIL} --role=$ROLE"
    exit 1
  fi
  sleep_for=$((attempts * 5))
  warn "IAM binding not yet propagated, retrying in ${sleep_for}s (attempt ${attempts}/${max_attempts})"
  sleep "$sleep_for"
done

# ---- create bucket if needed ------------------------------------------------
if gcloud storage buckets describe "gs://${BUCKET_NAME}" --project "$PROJECT_ID" >/dev/null 2>&1; then
  log "Bucket already exists: gs://${BUCKET_NAME}"
else
  log "Creating bucket: gs://${BUCKET_NAME} (location=${BUCKET_LOCATION})"
  gcloud storage buckets create "gs://${BUCKET_NAME}" \
    --project "$PROJECT_ID" \
    --location="$BUCKET_LOCATION" \
    --uniform-bucket-level-access
fi

# ---- generate key -----------------------------------------------------------
if [ -f "$KEY_FILE" ]; then
  warn "Key file already exists: $KEY_FILE"
  warn "Skipping key generation. Delete the file and re-run to rotate."
else
  log "Generating JSON key: $KEY_FILE"
  gcloud iam service-accounts keys create "$KEY_FILE" \
    --iam-account="$SA_EMAIL" \
    --project "$PROJECT_ID"
  chmod 600 "$KEY_FILE"
fi

# ---- write .env.local -------------------------------------------------------
log "Updating $ENV_FILE"
write_env GCS_PROJECT_ID "$PROJECT_ID"
write_env GCS_BUCKET_NAME "$BUCKET_NAME"
write_env GOOGLE_APPLICATION_CREDENTIALS "$KEY_FILE"

log "Done."
echo
log "  GCS_PROJECT_ID                 = $PROJECT_ID"
log "  GCS_BUCKET_NAME                = $BUCKET_NAME"
log "  GOOGLE_APPLICATION_CREDENTIALS = $KEY_FILE"
echo
log "Next: ensure GEMINI_API_KEY and DATABASE_URL are set in $ENV_FILE,"
log "      then run 'pnpm db:setup' and 'pnpm dev'."
