#!/usr/bin/env bash
# =============================================================================
# Cloud SQL for PostgreSQL — provisioning + schema bootstrap
#
# Idempotently:
#   1. Enables sqladmin / servicenetworking APIs
#   2. (Mode B only) Reserves a PSA peering range and peers it with VPC_NETWORK
#      so Cloud SQL can be assigned a Private IP reachable from Agent Engine.
#   3. Creates a Postgres 17 instance with pgvector
#         - Mode A:        Public IP only (Cloud Run uses unix socket)
#         - Mode B:        Private IP on VPC_NETWORK + Public IP for the
#                          one-time schema bootstrap from a workstation
#   4. Creates the application database and user
#   5. Downloads cloud-sql-proxy v2 (cached under /tmp)
#   6. Applies deploy/schema.sql via psql through the proxy
#   7. Syncs CLOUD_SQL_PASSWORD into deploy/.env.deploy AND/OR
#      deploy/.env.agent-engine, plus CLOUD_SQL_PRIVATE_IP for Mode B.
#
# Usage:
#   ./deploy/setup-cloud-sql.sh <PROJECT_ID>            # Mode A (default)
#   MODE=agent-engine VPC_NETWORK=my-vpc \
#     ./deploy/setup-cloud-sql.sh <PROJECT_ID>          # Mode B
#
# Env overrides:
#   MODE                   cloud-run | agent-engine     (default: cloud-run)
#   REGION                 (default: us-central1)
#   CLOUD_SQL_INSTANCE     (default: sap-rag-db)
#   CLOUD_SQL_DB           (default: sap_rag)
#   CLOUD_SQL_USER         (default: app)
#   CLOUD_SQL_PASSWORD     (auto-managed via .env files)
#   CLOUD_SQL_TIER         (default: db-custom-2-7680)
#   POSTGRES_VERSION       (default: POSTGRES_17)
#   STORAGE_GB             (default: 20)
#   VPC_NETWORK            (Mode B: required — VPC for Private IP peering)
#   PSA_RANGE_NAME         (Mode B: default sapphire-adk-psa-range)
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'

if [[ $# -lt 1 ]]; then
    echo -e "${RED}Usage: $0 <PROJECT_ID>${NC}"
    exit 1
fi

PROJECT_ID="$1"
MODE="${MODE:-cloud-run}"
REGION="${REGION:-us-central1}"
CLOUD_SQL_INSTANCE="${CLOUD_SQL_INSTANCE:-sap-rag-db}"
CLOUD_SQL_DB="${CLOUD_SQL_DB:-sap_rag}"
CLOUD_SQL_USER="${CLOUD_SQL_USER:-app}"
CLOUD_SQL_TIER="${CLOUD_SQL_TIER:-db-custom-2-7680}"
POSTGRES_VERSION="${POSTGRES_VERSION:-POSTGRES_17}"
STORAGE_GB="${STORAGE_GB:-20}"
VPC_NETWORK="${VPC_NETWORK:-}"
PSA_RANGE_NAME="${PSA_RANGE_NAME:-sapphire-adk-psa-range}"

if [[ "$MODE" != "cloud-run" && "$MODE" != "agent-engine" ]]; then
    echo -e "${RED}MODE must be 'cloud-run' or 'agent-engine' (got: $MODE)${NC}"
    exit 1
fi
if [[ "$MODE" == "agent-engine" && -z "$VPC_NETWORK" ]]; then
    echo -e "${RED}MODE=agent-engine requires VPC_NETWORK (the VPC where Agent Engine's PSC interface lives)${NC}"
    exit 1
fi

INSTANCE_CONNECTION_NAME="${PROJECT_ID}:${REGION}:${CLOUD_SQL_INSTANCE}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_FILE="${SCRIPT_DIR}/schema.sql"
ENV_DEPLOY="${SCRIPT_DIR}/.env.deploy"
ENV_DEPLOY_TEMPLATE="${SCRIPT_DIR}/.env.deploy.example"
ENV_AGENT_ENGINE="${SCRIPT_DIR}/.env.agent-engine"
ENV_AGENT_ENGINE_TEMPLATE="${SCRIPT_DIR}/.env.agent-engine.example"

if [[ ! -f "$SCHEMA_FILE" ]]; then
    echo -e "${RED}schema.sql not found at $SCHEMA_FILE${NC}"
    exit 1
fi

# ---------------------------------------------------------------------------
# Determine CLOUD_SQL_PASSWORD priority:
#   1. $CLOUD_SQL_PASSWORD env var
#   2. Existing non-placeholder value in the mode-relevant .env file
#   3. Auto-generate (24 chars, alphanumeric)
# ---------------------------------------------------------------------------
PASSWORD_SOURCE=""
PRIMARY_ENV_FILE="$ENV_DEPLOY"
[[ "$MODE" == "agent-engine" ]] && PRIMARY_ENV_FILE="$ENV_AGENT_ENGINE"

if [[ -n "${CLOUD_SQL_PASSWORD:-}" ]]; then
    PASSWORD_SOURCE="env var"
elif [[ -f "$PRIMARY_ENV_FILE" ]]; then
    EXISTING_ENV_PW=$(grep -E '^CLOUD_SQL_PASSWORD=' "$PRIMARY_ENV_FILE" \
        | head -n1 | sed -E 's/^CLOUD_SQL_PASSWORD=//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/')
    if [[ -n "$EXISTING_ENV_PW" && "$EXISTING_ENV_PW" != "replace-me" ]]; then
        CLOUD_SQL_PASSWORD="$EXISTING_ENV_PW"
        PASSWORD_SOURCE="$(basename "$PRIMARY_ENV_FILE") (existing)"
    fi
fi

if [[ -z "${CLOUD_SQL_PASSWORD:-}" ]]; then
    set +o pipefail
    CLOUD_SQL_PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)"
    set -o pipefail
    PASSWORD_SOURCE="auto-generated"
fi

echo -e "${BLUE}Cloud SQL setup${NC}"
echo "=============================================="
echo "Mode:          $MODE"
echo "Project:       $PROJECT_ID"
echo "Region:        $REGION"
echo "Instance:      $CLOUD_SQL_INSTANCE  ($POSTGRES_VERSION, $CLOUD_SQL_TIER)"
echo "Database:      $CLOUD_SQL_DB"
echo "App user:      $CLOUD_SQL_USER"
[[ "$MODE" == "agent-engine" ]] && echo "VPC network:   $VPC_NETWORK  (Private IP peering)"
echo "Connection:    $INSTANCE_CONNECTION_NAME"
echo "=============================================="

gcloud config set project "$PROJECT_ID" >/dev/null

echo -e "${BLUE}Enabling required APIs...${NC}"
gcloud services enable sqladmin.googleapis.com servicenetworking.googleapis.com >/dev/null
[[ "$MODE" == "agent-engine" ]] && gcloud services enable compute.googleapis.com >/dev/null

# ---------------------------------------------------------------------------
# 0. (Mode B only) PSA peering for Private IP
# ---------------------------------------------------------------------------
if [[ "$MODE" == "agent-engine" ]]; then
    if gcloud compute addresses describe "$PSA_RANGE_NAME" --global \
            --format='value(name)' >/dev/null 2>&1; then
        echo -e "${YELLOW}PSA range '$PSA_RANGE_NAME' already reserved${NC}"
    else
        echo -e "${BLUE}Reserving PSA range '$PSA_RANGE_NAME' for Cloud SQL Private IP...${NC}"
        gcloud compute addresses create "$PSA_RANGE_NAME" \
            --global \
            --purpose=VPC_PEERING \
            --prefix-length=16 \
            --network="$VPC_NETWORK" \
            --description="Service networking range for sap-rag-integration Cloud SQL Private IP"
    fi

    EXISTING_PEERING=$(gcloud services vpc-peerings list \
        --network="$VPC_NETWORK" --service=servicenetworking.googleapis.com \
        --format='value(name)' 2>/dev/null || true)
    if [[ -z "$EXISTING_PEERING" ]]; then
        echo -e "${BLUE}Establishing service networking peering with $VPC_NETWORK...${NC}"
        gcloud services vpc-peerings connect \
            --service=servicenetworking.googleapis.com \
            --ranges="$PSA_RANGE_NAME" \
            --network="$VPC_NETWORK"
    else
        echo -e "${YELLOW}Service networking peering already exists for $VPC_NETWORK${NC}"
    fi
fi

# ---------------------------------------------------------------------------
# 1. Instance
# ---------------------------------------------------------------------------
if gcloud sql instances describe "$CLOUD_SQL_INSTANCE" --format='value(name)' >/dev/null 2>&1; then
    echo -e "${YELLOW}Instance '$CLOUD_SQL_INSTANCE' already exists — skipping create${NC}"
else
    echo -e "${BLUE}Creating Cloud SQL instance '$CLOUD_SQL_INSTANCE' (this can take 5-10 min)...${NC}"
    CREATE_ARGS=(
        --edition="${CLOUD_SQL_EDITION:-ENTERPRISE}"
        --database-version="$POSTGRES_VERSION"
        --tier="$CLOUD_SQL_TIER"
        --region="$REGION"
        --storage-size="$STORAGE_GB"
        --storage-type=SSD
        --storage-auto-increase
        --backup-start-time=18:00
        --enable-point-in-time-recovery
    )
    if [[ "$MODE" == "agent-engine" ]]; then
        # Private IP for Agent Engine + Public IP for one-time schema bootstrap
        # via cloud-sql-proxy from this workstation. Strip --no-assign-ip if you
        # prefer Private-IP-only (then run schema apply from inside the VPC).
        CREATE_ARGS+=(
            --network="projects/${PROJECT_ID}/global/networks/${VPC_NETWORK}"
            --enable-google-private-path
        )
    fi
    gcloud sql instances create "$CLOUD_SQL_INSTANCE" "${CREATE_ARGS[@]}"
    echo -e "${GREEN}Instance created${NC}"
fi

# ---------------------------------------------------------------------------
# 2. Database
# ---------------------------------------------------------------------------
if gcloud sql databases describe "$CLOUD_SQL_DB" --instance="$CLOUD_SQL_INSTANCE" \
    --format='value(name)' >/dev/null 2>&1; then
    echo -e "${YELLOW}Database '$CLOUD_SQL_DB' already exists — skipping${NC}"
else
    echo -e "${BLUE}Creating database '$CLOUD_SQL_DB'...${NC}"
    gcloud sql databases create "$CLOUD_SQL_DB" --instance="$CLOUD_SQL_INSTANCE"
fi

# ---------------------------------------------------------------------------
# 3. User
# ---------------------------------------------------------------------------
EXISTING_USERS="$(gcloud sql users list --instance="$CLOUD_SQL_INSTANCE" --format='value(name)' 2>/dev/null || true)"
if printf '%s\n' "$EXISTING_USERS" | grep -qx "$CLOUD_SQL_USER"; then
    echo -e "${YELLOW}User '$CLOUD_SQL_USER' already exists — resetting password${NC}"
    gcloud sql users set-password "$CLOUD_SQL_USER" \
        --instance="$CLOUD_SQL_INSTANCE" \
        --password="$CLOUD_SQL_PASSWORD"
else
    echo -e "${BLUE}Creating user '$CLOUD_SQL_USER'...${NC}"
    gcloud sql users create "$CLOUD_SQL_USER" \
        --instance="$CLOUD_SQL_INSTANCE" \
        --password="$CLOUD_SQL_PASSWORD"
fi

# ---------------------------------------------------------------------------
# 4. Cloud SQL Auth Proxy
# ---------------------------------------------------------------------------
PROXY_BIN="/tmp/cloud-sql-proxy-v2"
if [[ ! -x "$PROXY_BIN" ]]; then
    UNAME_S="$(uname -s | tr '[:upper:]' '[:lower:]')"
    UNAME_M="$(uname -m)"
    case "$UNAME_M" in
        arm64|aarch64) ARCH="arm64" ;;
        x86_64|amd64)  ARCH="amd64" ;;
        *) echo -e "${RED}Unsupported arch: $UNAME_M${NC}"; exit 1 ;;
    esac
    case "$UNAME_S" in
        darwin) OS="darwin" ;;
        linux)  OS="linux"  ;;
        *) echo -e "${RED}Unsupported OS: $UNAME_S${NC}"; exit 1 ;;
    esac
    URL="https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.13.0/cloud-sql-proxy.${OS}.${ARCH}"
    echo -e "${BLUE}Downloading cloud-sql-proxy from $URL...${NC}"
    curl -fsSL "$URL" -o "$PROXY_BIN"
    chmod +x "$PROXY_BIN"
fi

# ---------------------------------------------------------------------------
# 5. Apply schema via proxy
# ---------------------------------------------------------------------------
if ! command -v psql >/dev/null 2>&1; then
    echo -e "${RED}psql not found in PATH. Install postgresql-client and retry.${NC}"
    exit 1
fi

PROXY_PORT="${PROXY_PORT:-5433}"
echo -e "${BLUE}Starting cloud-sql-proxy on localhost:${PROXY_PORT}...${NC}"
"$PROXY_BIN" --port "$PROXY_PORT" "$INSTANCE_CONNECTION_NAME" \
    >/tmp/cloud-sql-proxy.log 2>&1 &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT

for i in $(seq 1 30); do
    if nc -z localhost "$PROXY_PORT" 2>/dev/null; then
        echo -e "${GREEN}Proxy is up${NC}"
        break
    fi
    if [[ $i -eq 30 ]]; then
        echo -e "${RED}cloud-sql-proxy did not start. Tail of log:${NC}"
        tail -n 30 /tmp/cloud-sql-proxy.log
        exit 1
    fi
    sleep 1
done

echo -e "${BLUE}Applying schema.sql to '$CLOUD_SQL_DB'...${NC}"
PGPASSWORD="$CLOUD_SQL_PASSWORD" psql \
    --host=localhost \
    --port="$PROXY_PORT" \
    --username="$CLOUD_SQL_USER" \
    --dbname="$CLOUD_SQL_DB" \
    --set ON_ERROR_STOP=1 \
    --file="$SCHEMA_FILE"

echo -e "${GREEN}Schema applied${NC}"

# ---------------------------------------------------------------------------
# 6. Sync password (and Private IP for Mode B) into deploy env files.
# ---------------------------------------------------------------------------
sync_env_file() {
    local target="$1"
    local template="$2"
    if [[ ! -f "$target" ]]; then
        if [[ -f "$template" ]]; then
            cp "$template" "$target"
            echo -e "${BLUE}Created $target from template${NC}"
        else
            return 0
        fi
    fi
    TARGET_FILE="$target" CLOUD_SQL_PASSWORD="$CLOUD_SQL_PASSWORD" python3 - <<'PYEOF'
import os, re, pathlib
path = pathlib.Path(os.environ["TARGET_FILE"])
new_pw = os.environ["CLOUD_SQL_PASSWORD"]
content = path.read_text()
line = f"CLOUD_SQL_PASSWORD={new_pw}"
if re.search(r"^CLOUD_SQL_PASSWORD=.*$", content, flags=re.MULTILINE):
    content = re.sub(r"^CLOUD_SQL_PASSWORD=.*$", line, content, flags=re.MULTILINE)
else:
    if not content.endswith("\n"):
        content += "\n"
    content += line + "\n"
path.write_text(content)
PYEOF
    echo -e "${GREEN}Synced CLOUD_SQL_PASSWORD into $(basename "$target")${NC}"
}

# Always sync the primary env file. If the sibling exists (e.g. user set up
# both modes against one instance), sync it too.
sync_env_file "$PRIMARY_ENV_FILE" \
    "$([[ "$MODE" == "agent-engine" ]] && echo "$ENV_AGENT_ENGINE_TEMPLATE" || echo "$ENV_DEPLOY_TEMPLATE")"

if [[ "$MODE" == "cloud-run" && -f "$ENV_AGENT_ENGINE" ]]; then
    sync_env_file "$ENV_AGENT_ENGINE" "$ENV_AGENT_ENGINE_TEMPLATE"
fi
if [[ "$MODE" == "agent-engine" && -f "$ENV_DEPLOY" ]]; then
    sync_env_file "$ENV_DEPLOY" "$ENV_DEPLOY_TEMPLATE"
fi

# ---------------------------------------------------------------------------
# 7. (Mode B) Capture Private IP into .env.agent-engine.
# ---------------------------------------------------------------------------
if [[ "$MODE" == "agent-engine" ]]; then
    PRIVATE_IP=$(gcloud sql instances describe "$CLOUD_SQL_INSTANCE" \
        --format='value(ipAddresses.filter("type=PRIVATE").extract("ipAddress").flatten())' \
        2>/dev/null | head -n1)
    if [[ -z "$PRIVATE_IP" ]]; then
        echo -e "${YELLOW}Cloud SQL Private IP not yet visible — re-run the script in 30s if it stays empty${NC}"
    else
        TARGET_FILE="$ENV_AGENT_ENGINE" PRIVATE_IP="$PRIVATE_IP" python3 - <<'PYEOF'
import os, re, pathlib
path = pathlib.Path(os.environ["TARGET_FILE"])
ip = os.environ["PRIVATE_IP"]
content = path.read_text()
line = f"CLOUD_SQL_PRIVATE_IP={ip}"
if re.search(r"^CLOUD_SQL_PRIVATE_IP=.*$", content, flags=re.MULTILINE):
    content = re.sub(r"^CLOUD_SQL_PRIVATE_IP=.*$", line, content, flags=re.MULTILINE)
else:
    if not content.endswith("\n"):
        content += "\n"
    content += line + "\n"
path.write_text(content)
PYEOF
        echo -e "${GREEN}Synced CLOUD_SQL_PRIVATE_IP=$PRIVATE_IP into .env.agent-engine${NC}"
    fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=============================================="
echo -e "${GREEN}Cloud SQL ready${NC}"
echo "=============================================="
echo "INSTANCE_CONNECTION_NAME=$INSTANCE_CONNECTION_NAME"
echo "DB=$CLOUD_SQL_DB  USER=$CLOUD_SQL_USER"
echo "Password source: $PASSWORD_SOURCE"
echo ""
if [[ "$MODE" == "cloud-run" ]]; then
    echo "DATABASE_URL for Cloud Run (auto-built by deploy-cloud-run.sh):"
    echo "  postgresql://${CLOUD_SQL_USER}:<URL-ENCODED-PASSWORD>@localhost/${CLOUD_SQL_DB}?host=/cloudsql/${INSTANCE_CONNECTION_NAME}"
    echo ""
    echo "Next:"
    echo "  \$ \$EDITOR $ENV_DEPLOY"
    echo "  \$ ./deploy/deploy-cloud-run.sh $PROJECT_ID"
else
    echo "DATABASE_URL for Agent Engine (auto-built by deploy-agent-engine.py):"
    echo "  postgresql://${CLOUD_SQL_USER}:<URL-ENCODED-PASSWORD>@${PRIVATE_IP:-<PRIVATE_IP>}:5432/${CLOUD_SQL_DB}"
    echo ""
    echo "Next:"
    echo "  \$ ./deploy/setup-agent-engine.sh $PROJECT_ID"
    echo "  \$ python deploy/deploy-agent-engine.py --project $PROJECT_ID"
fi
