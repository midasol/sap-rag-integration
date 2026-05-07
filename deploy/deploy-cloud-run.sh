#!/usr/bin/env bash
# =============================================================================
# Mode A — Cloud Run × 2 (nextjs + adk_agent) sharing one Cloud SQL.
#
# - Next.js: built by Cloud Build via Buildpacks (`packageManager` field in
#   package.json picks pnpm).
# - adk_agent: built by Cloud Build via the Dockerfile at adk_agent/Dockerfile.
#
# Both services use Cloud SQL via the unix socket mounted by
# --add-cloudsql-instances (no VPC needed for the DB hop). adk_agent
# additionally uses a Serverless VPC Access Connector to reach SAP S/4HANA
# on its private IP.
#
# Usage:
#   ./deploy/deploy-cloud-run.sh <PROJECT_ID>
#
# Required: deploy/.env.deploy (copy from .env.deploy.example, fill in).
# Run ./deploy/setup-cloud-sql.sh first.
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'

if [[ $# -lt 1 ]]; then
    echo -e "${RED}Usage: $0 <PROJECT_ID>${NC}"
    exit 1
fi

PROJECT_ID="$1"
REGION="${REGION:-us-central1}"
APP_SERVICE="${APP_SERVICE:-sap-rag-web}"
AGENT_SERVICE="${AGENT_SERVICE:-sap-rag-agent}"
RUNTIME_SA_NAME="${RUNTIME_SA_NAME:-sap-rag-runner}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env.deploy}"

if [[ ! -f "$ENV_FILE" ]]; then
    echo -e "${RED}Missing $ENV_FILE${NC}"
    echo "Copy deploy/.env.deploy.example to deploy/.env.deploy and fill in values."
    exit 1
fi

# ---- Load deploy env ----
echo -e "${BLUE}Loading deploy env from $ENV_FILE...${NC}"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

REQUIRED=(
    CLOUD_SQL_INSTANCE CLOUD_SQL_DB CLOUD_SQL_USER CLOUD_SQL_PASSWORD
    GEMINI_API_KEY GCS_BUCKET_NAME GCS_PROJECT_ID SAP_SESSION_SECRET
    SAP_CRED_ENCRYPTION_KEY EMBED_MODEL EMBED_OUTPUT_DIM SAP_HOST
)
for v in "${REQUIRED[@]}"; do
    if [[ -z "${!v:-}" || "${!v}" == "replace-me" ]]; then
        echo -e "${RED}$v is missing or still 'replace-me' in $ENV_FILE${NC}"
        exit 1
    fi
done

GEMINI_EMBEDDING_MODEL="${GEMINI_EMBEDDING_MODEL:-gemini-embedding-2-preview}"
GEMINI_CHAT_MODEL="${GEMINI_CHAT_MODEL:-gemini-3.1-pro-preview}"
SAP_AGENT_MODEL="${SAP_AGENT_MODEL:-gemini-3.1-pro-preview}"
EMBED_NORMALIZE="${EMBED_NORMALIZE:-true}"
SAP_AUTH_TYPE="${SAP_AUTH_TYPE:-basic}"
SAP_PORT="${SAP_PORT:-44300}"
SAP_CLIENT="${SAP_CLIENT:-100}"
SAP_VERIFY_SSL="${SAP_VERIFY_SSL:-true}"
ADK_SESSION_BACKEND="${ADK_SESSION_BACKEND:-memory}"
REQUIRE_AUTH="${REQUIRE_AUTH:-true}"
CONNECTOR_IP_RANGE="${CONNECTOR_IP_RANGE:-10.8.0.0/28}"
FIREWALL_RULE_NAME="${FIREWALL_RULE_NAME:-allow-cloudrun-to-sap}"

INSTANCE_CONNECTION_NAME="${PROJECT_ID}:${REGION}:${CLOUD_SQL_INSTANCE}"
RUNTIME_SA_EMAIL="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# ---------------------------------------------------------------------------
# Auto-derive VPC_NETWORK / VPC_CONNECTOR_NAME from SAP_HOST when it is a
# private IPv4 address (RFC 1918) and either is unset. Mirrors the reference
# repo's helper.
# ---------------------------------------------------------------------------
is_private_ipv4() {
    local ip="$1"
    [[ "$ip" =~ ^10\. ]] && return 0
    [[ "$ip" =~ ^192\.168\. ]] && return 0
    [[ "$ip" =~ ^172\.(1[6-9]|2[0-9]|3[0-1])\. ]] && return 0
    return 1
}

if is_private_ipv4 "$SAP_HOST" && { [[ -z "${VPC_NETWORK:-}" ]] || [[ -z "${VPC_CONNECTOR_NAME:-}" ]]; }; then
    echo -e "${BLUE}Auto-detecting VPC for SAP_HOST=$SAP_HOST...${NC}"
    gcloud services enable compute.googleapis.com >/dev/null 2>&1 || true

    set +o pipefail
    DETECTED_NETWORK=$(gcloud compute instances list \
        --project="$PROJECT_ID" \
        --filter="networkInterfaces.networkIP=$SAP_HOST" \
        --format='value(networkInterfaces[0].network.basename())' 2>/dev/null \
        | head -n1)
    set -o pipefail

    if [[ -z "$DETECTED_NETWORK" ]]; then
        echo -e "${YELLOW}Could not find a GCE instance with IP $SAP_HOST in project $PROJECT_ID.${NC}"
        echo -e "${YELLOW}Skipping VPC auto-detection — set VPC_NETWORK / VPC_CONNECTOR_NAME manually if needed.${NC}"
    else
        if [[ -z "${VPC_NETWORK:-}" ]]; then
            VPC_NETWORK="$DETECTED_NETWORK"
            echo -e "${GREEN}  VPC_NETWORK        = $VPC_NETWORK  (auto)${NC}"
        elif [[ "$VPC_NETWORK" != "$DETECTED_NETWORK" ]]; then
            echo -e "${YELLOW}  VPC_NETWORK in .env.deploy ($VPC_NETWORK) differs from detected ($DETECTED_NETWORK) — keeping .env.deploy value${NC}"
        fi
        if [[ -z "${VPC_CONNECTOR_NAME:-}" ]]; then
            VPC_CONNECTOR_NAME="${VPC_NETWORK}-connector"
            echo -e "${GREEN}  VPC_CONNECTOR_NAME = $VPC_CONNECTOR_NAME  (auto)${NC}"
        fi
    fi
fi

echo -e "${BLUE}Deploy configuration${NC}"
echo "=============================================="
echo "Project:          $PROJECT_ID"
echo "Region:           $REGION"
echo "Web service:      $APP_SERVICE"
echo "Agent service:    $AGENT_SERVICE"
echo "Runtime SA:       $RUNTIME_SA_EMAIL"
echo "Cloud SQL:        $INSTANCE_CONNECTION_NAME / $CLOUD_SQL_DB"
echo "VPC network:      ${VPC_NETWORK:-<none>}"
echo "VPC connector:    ${VPC_CONNECTOR_NAME:-<none — adk_agent has no VPC>}"
echo "SAP host:         ${SAP_HOST:-<none>}:${SAP_PORT}"
echo "=============================================="

gcloud config set project "$PROJECT_ID" >/dev/null

echo -e "${BLUE}Enabling required APIs...${NC}"
gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    sqladmin.googleapis.com \
    vpcaccess.googleapis.com \
    secretmanager.googleapis.com >/dev/null

# ---- Runtime service account ----
if ! gcloud iam service-accounts describe "$RUNTIME_SA_EMAIL" \
        --format='value(email)' >/dev/null 2>&1; then
    echo -e "${BLUE}Creating runtime service account $RUNTIME_SA_EMAIL...${NC}"
    gcloud iam service-accounts create "$RUNTIME_SA_NAME" \
        --display-name="sap-rag-integration Cloud Run runtime"

    echo -e "${BLUE}Waiting for SA to propagate...${NC}"
    for i in $(seq 1 30); do
        if gcloud iam service-accounts describe "$RUNTIME_SA_EMAIL" \
                --format='value(email)' >/dev/null 2>&1; then
            sleep 2
            break
        fi
        sleep 2
    done
else
    echo -e "${YELLOW}Runtime SA already exists${NC}"
fi

SA_ROLES=(
    roles/cloudsql.client
    roles/storage.objectAdmin
    roles/aiplatform.user            # Gemini API via ADC
    roles/logging.logWriter
    roles/monitoring.metricWriter
)
# Pub/Sub MCP roles only when .mcp.json is shipped
if [[ -f "$PROJECT_ROOT/.mcp.json" ]]; then
    SA_ROLES+=(roles/mcp.toolUser roles/pubsub.editor)
fi
for ROLE in "${SA_ROLES[@]}"; do
    for attempt in 1 2 3 4 5; do
        if gcloud projects add-iam-policy-binding "$PROJECT_ID" \
                --member="serviceAccount:$RUNTIME_SA_EMAIL" \
                --role="$ROLE" \
                --condition=None >/dev/null 2>&1; then
            break
        fi
        if [[ "$attempt" -eq 5 ]]; then
            echo -e "${RED}Failed to bind $ROLE to $RUNTIME_SA_EMAIL after 5 attempts${NC}"
            exit 1
        fi
        echo "  retry $attempt/5: binding $ROLE..."
        sleep 5
    done
done

# ---- Optional VPC connector + firewall rule ----
if [[ -n "${VPC_CONNECTOR_NAME:-}" ]]; then
    if [[ -z "${VPC_NETWORK:-}" ]]; then
        echo -e "${RED}VPC_CONNECTOR_NAME is set but VPC_NETWORK is empty${NC}"
        exit 1
    fi

    echo -e "${BLUE}Ensuring VPC connector '$VPC_CONNECTOR_NAME'...${NC}"
    EXISTING_STATE=$(gcloud compute networks vpc-access connectors describe \
        "$VPC_CONNECTOR_NAME" --region="$REGION" \
        --format='value(state)' 2>/dev/null || echo "")

    if [[ "$EXISTING_STATE" == "READY" ]]; then
        echo -e "${YELLOW}VPC connector already exists (READY)${NC}"
    else
        if [[ "$EXISTING_STATE" == "ERROR" ]]; then
            echo -e "${YELLOW}VPC connector is in ERROR state — deleting before retry...${NC}"
            gcloud compute networks vpc-access connectors delete \
                "$VPC_CONNECTOR_NAME" --region="$REGION" --quiet
        elif [[ -n "$EXISTING_STATE" ]]; then
            echo -e "${YELLOW}VPC connector in state '$EXISTING_STATE' — waiting...${NC}"
            for i in $(seq 1 30); do
                S=$(gcloud compute networks vpc-access connectors describe \
                    "$VPC_CONNECTOR_NAME" --region="$REGION" \
                    --format='value(state)' 2>/dev/null || echo "")
                [[ "$S" == "READY" ]] && break
                sleep 10
            done
            EXISTING_STATE="$S"
        fi
    fi

    if [[ "$EXISTING_STATE" != "READY" ]]; then
        gcloud compute networks vpc-access connectors create "$VPC_CONNECTOR_NAME" \
            --region="$REGION" \
            --network="$VPC_NETWORK" \
            --range="$CONNECTOR_IP_RANGE" \
            --min-instances=2 \
            --max-instances=3
        for i in $(seq 1 30); do
            STATE=$(gcloud compute networks vpc-access connectors describe \
                "$VPC_CONNECTOR_NAME" --region="$REGION" \
                --format='value(state)' 2>/dev/null || echo "UNKNOWN")
            [[ "$STATE" == "READY" ]] && break
            echo "  connector state: $STATE ($i/30)"
            sleep 10
        done
    fi

    if [[ -n "${SAP_TARGET_TAG:-}" ]]; then
        if gcloud compute firewall-rules describe "$FIREWALL_RULE_NAME" \
                --format='value(name)' >/dev/null 2>&1; then
            echo -e "${YELLOW}Firewall rule '$FIREWALL_RULE_NAME' already exists${NC}"
        else
            echo -e "${BLUE}Creating firewall rule '$FIREWALL_RULE_NAME'...${NC}"
            gcloud compute firewall-rules create "$FIREWALL_RULE_NAME" \
                --network="$VPC_NETWORK" \
                --direction=INGRESS \
                --action=ALLOW \
                --rules="tcp:$SAP_PORT" \
                --source-ranges="$CONNECTOR_IP_RANGE" \
                --target-tags="$SAP_TARGET_TAG" \
                --description="Allow Cloud Run VPC connector to reach SAP on $SAP_PORT"
        fi
    fi
else
    echo -e "${YELLOW}VPC_CONNECTOR_NAME empty — adk_agent will deploy without VPC${NC}"
fi

# ---- Pre-flight: verify CLOUD_SQL_PASSWORD authenticates ----
echo ""
echo -e "${BLUE}Pre-flight: verifying Cloud SQL credentials...${NC}"
PROXY_BIN="/tmp/cloud-sql-proxy-v2"
if [[ ! -x "$PROXY_BIN" ]]; then
    UNAME_S="$(uname -s | tr '[:upper:]' '[:lower:]')"
    case "$(uname -m)" in arm64|aarch64) PFA="arm64" ;; *) PFA="amd64" ;; esac
    case "$UNAME_S" in darwin) PFO="darwin" ;; *) PFO="linux" ;; esac
    curl -fsSL "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.13.0/cloud-sql-proxy.${PFO}.${PFA}" \
        -o "$PROXY_BIN" && chmod +x "$PROXY_BIN"
fi

if ! command -v psql >/dev/null 2>&1; then
    echo -e "${YELLOW}psql not found — skipping DB credential pre-flight${NC}"
else
    PREFLIGHT_PORT=5435
    "$PROXY_BIN" --port "$PREFLIGHT_PORT" "$INSTANCE_CONNECTION_NAME" \
        >/tmp/preflight-proxy.log 2>&1 &
    PREFLIGHT_PID=$!
    PREFLIGHT_OK=1
    for i in $(seq 1 15); do
        nc -z localhost "$PREFLIGHT_PORT" 2>/dev/null && break
        [[ $i -eq 15 ]] && { PREFLIGHT_OK=0; }
        sleep 1
    done
    if [[ "$PREFLIGHT_OK" -eq 1 ]]; then
        if PGPASSWORD="$CLOUD_SQL_PASSWORD" psql \
                --host=localhost --port="$PREFLIGHT_PORT" \
                --username="$CLOUD_SQL_USER" --dbname="$CLOUD_SQL_DB" \
                --no-password -tAc 'SELECT 1' >/dev/null 2>&1; then
            echo -e "${GREEN}Cloud SQL credentials OK${NC}"
        else
            kill "$PREFLIGHT_PID" 2>/dev/null || true
            echo -e "${RED}Cloud SQL authentication failed for user '$CLOUD_SQL_USER'.${NC}"
            echo "Re-run setup to sync the password back into .env.deploy:"
            echo "  ./deploy/setup-cloud-sql.sh $PROJECT_ID"
            exit 1
        fi
    else
        echo -e "${YELLOW}cloud-sql-proxy did not become ready — skipping pre-flight${NC}"
    fi
    kill "$PREFLIGHT_PID" 2>/dev/null || true
fi

# ---- Build the DATABASE_URL (URL-encode the password) ----
ENC_PW=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$CLOUD_SQL_PASSWORD")
DATABASE_URL="postgresql://${CLOUD_SQL_USER}:${ENC_PW}@localhost/${CLOUD_SQL_DB}?host=/cloudsql/${INSTANCE_CONNECTION_NAME}"

# ---- Build + deploy adk_agent first (so the web service knows ADK_BASE_URL) ----
echo ""
echo -e "${BLUE}Deploying adk_agent via Cloud Build (--source + Dockerfile)...${NC}"

AGENT_DEPLOY_FLAGS=(
    --source="$PROJECT_ROOT"
    --dockerfile="$PROJECT_ROOT/adk_agent/Dockerfile"
    --platform=managed
    --region="$REGION"
    --service-account="$RUNTIME_SA_EMAIL"
    --port=8200
    --memory=2Gi
    --cpu=2
    # ADK auth state lives in process memory — pin to one always-on instance.
    --min-instances=1
    --max-instances=1
    --timeout=300
    --no-allow-unauthenticated
    --add-cloudsql-instances="$INSTANCE_CONNECTION_NAME"
)
if [[ -n "${VPC_CONNECTOR_NAME:-}" ]]; then
    AGENT_DEPLOY_FLAGS+=(
        --vpc-connector="projects/$PROJECT_ID/locations/$REGION/connectors/$VPC_CONNECTOR_NAME"
        --vpc-egress=private-ranges-only
    )
fi

# Use ';;' as the env-var separator so values may contain commas / =.
AGENT_ENV="\
DATABASE_URL=${DATABASE_URL};;\
SAP_AGENT_MODEL=${SAP_AGENT_MODEL};;\
EMBED_MODEL=${EMBED_MODEL};;\
EMBED_OUTPUT_DIM=${EMBED_OUTPUT_DIM};;\
EMBED_NORMALIZE=${EMBED_NORMALIZE};;\
SAP_CRED_ENCRYPTION_KEY=${SAP_CRED_ENCRYPTION_KEY};;\
SAP_AUTH_TYPE=${SAP_AUTH_TYPE};;\
SAP_HOST=${SAP_HOST};;\
SAP_PORT=${SAP_PORT};;\
SAP_CLIENT=${SAP_CLIENT};;\
SAP_VERIFY_SSL=${SAP_VERIFY_SSL};;\
SAP_OAUTH_CLIENT_ID=${SAP_OAUTH_CLIENT_ID:-};;\
SAP_OAUTH_CLIENT_SECRET=${SAP_OAUTH_CLIENT_SECRET:-};;\
SAP_OAUTH_TOKEN_URL=${SAP_OAUTH_TOKEN_URL:-};;\
SAP_OAUTH_AUTHORIZE_URL=${SAP_OAUTH_AUTHORIZE_URL:-};;\
SAP_OAUTH_REDIRECT_URI=${SAP_OAUTH_REDIRECT_URI:-};;\
ADK_SESSION_BACKEND=${ADK_SESSION_BACKEND};;\
GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"

gcloud run deploy "$AGENT_SERVICE" \
    "${AGENT_DEPLOY_FLAGS[@]}" \
    --set-env-vars="^;;^${AGENT_ENV}"

AGENT_URL=$(gcloud run services describe "$AGENT_SERVICE" \
    --region="$REGION" --format='value(status.url)')
echo -e "${GREEN}adk_agent: $AGENT_URL${NC}"

# Allow the web service's runtime SA to invoke the agent service
echo -e "${BLUE}Granting roles/run.invoker on $AGENT_SERVICE to the runtime SA...${NC}"
gcloud run services add-iam-policy-binding "$AGENT_SERVICE" \
    --region="$REGION" \
    --member="serviceAccount:$RUNTIME_SA_EMAIL" \
    --role="roles/run.invoker" >/dev/null

# ---- Build + deploy Next.js web service ----
echo ""
echo -e "${BLUE}Deploying Next.js web service via Cloud Build (--source)...${NC}"

APP_ENV="\
NODE_ENV=production;;\
GEMINI_API_KEY=${GEMINI_API_KEY};;\
GEMINI_EMBEDDING_MODEL=${GEMINI_EMBEDDING_MODEL};;\
GEMINI_CHAT_MODEL=${GEMINI_CHAT_MODEL};;\
GCS_BUCKET_NAME=${GCS_BUCKET_NAME};;\
GCS_PROJECT_ID=${GCS_PROJECT_ID};;\
SAP_SESSION_SECRET=${SAP_SESSION_SECRET};;\
ADK_BASE_URL=${AGENT_URL};;\
DATABASE_URL=${DATABASE_URL};;\
REQUIRE_AUTH=${REQUIRE_AUTH};;\
LOG_FORMAT=json;;\
LOG_LEVEL=info"

# Build-time placeholders. `next build` collects page data by importing every
# route, which can trigger module-load-time env lookups. All env.ts getters
# are lazy, but providing harmless defaults shields any third-party code.
BUILD_ENV="\
DATABASE_URL=postgresql://placeholder@/placeholder;;\
GEMINI_API_KEY=placeholder;;\
GCS_BUCKET_NAME=placeholder;;\
GCS_PROJECT_ID=placeholder;;\
SAP_SESSION_SECRET=placeholder-build-time-secret-at-least-32-chars-xx"

gcloud run deploy "$APP_SERVICE" \
    --source="$PROJECT_ROOT" \
    --platform=managed \
    --region="$REGION" \
    --service-account="$RUNTIME_SA_EMAIL" \
    --port=3000 \
    --memory=2Gi \
    --cpu=2 \
    --min-instances=0 \
    --max-instances=10 \
    --timeout=300 \
    --allow-unauthenticated \
    --add-cloudsql-instances="$INSTANCE_CONNECTION_NAME" \
    --set-build-env-vars="^;;^${BUILD_ENV}" \
    --set-env-vars="^;;^${APP_ENV}"

APP_URL=$(gcloud run services describe "$APP_SERVICE" \
    --region="$REGION" --format='value(status.url)')

echo ""
echo "=============================================="
echo -e "${GREEN}Deployment complete${NC}"
echo "=============================================="
echo "Web (Next.js):    $APP_URL"
echo "Agent (ADK):      $AGENT_URL  (private — IAM invoker only)"
echo ""
echo "Cloud SQL:        $INSTANCE_CONNECTION_NAME"
echo "Runtime SA:       $RUNTIME_SA_EMAIL"
if [[ -n "${VPC_CONNECTOR_NAME:-}" ]]; then
    echo "VPC connector:    $VPC_CONNECTOR_NAME ($CONNECTOR_IP_RANGE)"
fi
echo ""
echo "Console:          https://console.cloud.google.com/run?project=$PROJECT_ID"
echo "=============================================="
