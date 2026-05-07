#!/usr/bin/env bash
# =============================================================================
# Mode B prerequisites — Vertex AI Agent Engine
#
# Idempotently provisions:
#   1. Required GCP APIs
#   2. Runtime service account `agent-engine-sa` + IAM
#   3. AI Platform service-agent IAM (compute.networkAdmin, dns.peer)
#   4. PSC subnet + network attachment in VPC_NETWORK
#   5. Firewall allowing PSC subnet → SAP_HOST on tcp:44300,443
#   6. Cloud Build staging bucket
#   7. Secret Manager secrets (sap-credentials, sap-cred-encryption-key)
#
# Usage:
#   ./deploy/setup-agent-engine.sh <PROJECT_ID>
#
# Required env (read from deploy/.env.agent-engine):
#   VPC_NETWORK            VPC where SAP + Cloud SQL Private IP live
#   PSC_SUBNET_RANGE       e.g. 192.168.10.0/28 (must not collide)
#   SAP_HOST               SAP S/4HANA private IP (firewall destination)
#
# Run ./deploy/setup-cloud-sql.sh MODE=agent-engine first so PSA peering
# is in place and CLOUD_SQL_PRIVATE_IP is filled in .env.agent-engine.
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'

if [[ $# -lt 1 ]]; then
    echo -e "${RED}Usage: $0 <PROJECT_ID>${NC}"
    exit 1
fi

PROJECT_ID="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env.agent-engine}"

if [[ ! -f "$ENV_FILE" ]]; then
    echo -e "${RED}Missing $ENV_FILE${NC}"
    echo "Copy deploy/.env.agent-engine.example to deploy/.env.agent-engine and fill in values."
    exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

REGION="${REGION:-us-central1}"
PSC_SUBNET_NAME="${PSC_SUBNET_NAME:-psc-attachment-subnet}"
PSC_SUBNET_RANGE="${PSC_SUBNET_RANGE:-192.168.10.0/28}"
NETWORK_ATTACHMENT_NAME="${NETWORK_ATTACHMENT_NAME:-agent-engine-attachment}"
AGENT_ENGINE_SA="${AGENT_ENGINE_SA:-agent-engine-sa}"
SAP_PORT="${SAP_PORT:-44300}"
SAP_CREDENTIALS_SECRET="${SAP_CREDENTIALS_SECRET:-sap-credentials}"
SAP_CRED_ENCRYPTION_KEY_SECRET="${SAP_CRED_ENCRYPTION_KEY_SECRET:-sap-cred-encryption-key}"

if [[ -z "${VPC_NETWORK:-}" ]]; then
    echo -e "${RED}VPC_NETWORK is required in $ENV_FILE${NC}"
    exit 1
fi

SA_EMAIL="${AGENT_ENGINE_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
STAGING_BUCKET_DEFAULT="${PROJECT_ID}_cloudbuild"
STAGING_BUCKET_NAME="${STAGING_BUCKET:-gs://${STAGING_BUCKET_DEFAULT}}"
STAGING_BUCKET_NAME="${STAGING_BUCKET_NAME#gs://}"

echo -e "${BLUE}Agent Engine prerequisites${NC}"
echo "=============================================="
echo "Project:           $PROJECT_ID"
echo "Region:            $REGION"
echo "Service account:   $SA_EMAIL"
echo "VPC network:       $VPC_NETWORK"
echo "PSC subnet:        $PSC_SUBNET_NAME ($PSC_SUBNET_RANGE)"
echo "Network attach:    $NETWORK_ATTACHMENT_NAME"
echo "Staging bucket:    gs://$STAGING_BUCKET_NAME"
echo "Secrets:           $SAP_CREDENTIALS_SECRET, $SAP_CRED_ENCRYPTION_KEY_SECRET"
echo "=============================================="

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

# ---- 1. APIs ----
echo -e "${BLUE}Enabling APIs...${NC}"
gcloud services enable \
    compute.googleapis.com \
    aiplatform.googleapis.com \
    secretmanager.googleapis.com \
    cloudbuild.googleapis.com \
    storage.googleapis.com \
    iam.googleapis.com \
    iamcredentials.googleapis.com \
    dns.googleapis.com \
    servicenetworking.googleapis.com >/dev/null

# ---- 2. Service account ----
if gcloud iam service-accounts describe "$SA_EMAIL" \
        --project="$PROJECT_ID" --format='value(email)' >/dev/null 2>&1; then
    echo -e "${YELLOW}Service account $AGENT_ENGINE_SA already exists${NC}"
else
    echo -e "${BLUE}Creating service account $AGENT_ENGINE_SA...${NC}"
    gcloud iam service-accounts create "$AGENT_ENGINE_SA" \
        --project="$PROJECT_ID" \
        --display-name="sapphire26 Agent Engine runtime" \
        --description="Runtime SA for ADK agent on Vertex AI Agent Engine"
    for i in $(seq 1 30); do
        gcloud iam service-accounts describe "$SA_EMAIL" --format='value(email)' \
            >/dev/null 2>&1 && { sleep 2; break; }
        sleep 2
    done
fi

SA_ROLES=(
    roles/aiplatform.user
    roles/secretmanager.secretAccessor
    roles/cloudsql.client
    roles/storage.objectViewer
    roles/logging.logWriter
    roles/monitoring.metricWriter
    roles/serviceusage.serviceUsageConsumer
)
for ROLE in "${SA_ROLES[@]}"; do
    for attempt in 1 2 3; do
        if gcloud projects add-iam-policy-binding "$PROJECT_ID" \
                --member="serviceAccount:$SA_EMAIL" \
                --role="$ROLE" \
                --condition=None >/dev/null 2>&1; then
            break
        fi
        [[ "$attempt" -eq 3 ]] && { echo -e "${RED}Failed to bind $ROLE${NC}"; exit 1; }
        sleep 5
    done
done

# Optional Pub/Sub MCP roles (only if .mcp.json is in the repo)
if [[ -f "$(dirname "$SCRIPT_DIR")/.mcp.json" ]]; then
    for ROLE in roles/mcp.toolUser roles/pubsub.editor; do
        gcloud projects add-iam-policy-binding "$PROJECT_ID" \
            --member="serviceAccount:$SA_EMAIL" \
            --role="$ROLE" \
            --condition=None >/dev/null 2>&1 || true
    done
fi

# ---- 3. AI Platform service-agent IAM (PSC interface needs network admin) ----
echo -e "${BLUE}Granting PSC roles to AI Platform service agents...${NC}"
SERVICE_AGENTS=(
    "service-${PROJECT_NUMBER}@gcp-sa-aiplatform.iam.gserviceaccount.com"
    "service-${PROJECT_NUMBER}@gcp-sa-aiplatform-re.iam.gserviceaccount.com"
)
AGENT_ROLES=(
    roles/serviceusage.serviceUsageConsumer
    roles/compute.networkAdmin
)
for sa in "${SERVICE_AGENTS[@]}"; do
    for role in "${AGENT_ROLES[@]}"; do
        gcloud projects add-iam-policy-binding "$PROJECT_ID" \
            --member="serviceAccount:$sa" \
            --role="$role" \
            --condition=None >/dev/null 2>&1 \
            || echo -e "${YELLOW}  skipped $role on $sa (agent may not exist yet)${NC}"
    done
done
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-aiplatform.iam.gserviceaccount.com" \
    --role="roles/dns.peer" \
    --condition=None >/dev/null 2>&1 \
    || echo -e "${YELLOW}  skipped dns.peer (agent may not exist yet)${NC}"

# ---- 4. PSC subnet + network attachment ----
if gcloud compute networks subnets describe "$PSC_SUBNET_NAME" \
        --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo -e "${YELLOW}Subnet $PSC_SUBNET_NAME already exists${NC}"
else
    echo -e "${BLUE}Creating PSC subnet $PSC_SUBNET_NAME ($PSC_SUBNET_RANGE)...${NC}"
    gcloud compute networks subnets create "$PSC_SUBNET_NAME" \
        --project="$PROJECT_ID" \
        --network="$VPC_NETWORK" \
        --range="$PSC_SUBNET_RANGE" \
        --region="$REGION"
fi

if gcloud compute network-attachments describe "$NETWORK_ATTACHMENT_NAME" \
        --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo -e "${YELLOW}Network attachment $NETWORK_ATTACHMENT_NAME already exists${NC}"
else
    echo -e "${BLUE}Creating network attachment $NETWORK_ATTACHMENT_NAME...${NC}"
    gcloud compute network-attachments create "$NETWORK_ATTACHMENT_NAME" \
        --project="$PROJECT_ID" \
        --region="$REGION" \
        --connection-preference=ACCEPT_AUTOMATIC \
        --subnets="$PSC_SUBNET_NAME"
fi

# ---- 5. Firewall: PSC subnet → SAP_HOST ----
if [[ -n "${SAP_HOST:-}" ]]; then
    FW_NAME="allow-agent-engine-to-sap"
    if gcloud compute firewall-rules describe "$FW_NAME" \
            --project="$PROJECT_ID" >/dev/null 2>&1; then
        echo -e "${YELLOW}Firewall rule $FW_NAME already exists${NC}"
    else
        echo -e "${BLUE}Creating firewall rule $FW_NAME (PSC → SAP $SAP_HOST:$SAP_PORT)...${NC}"
        gcloud compute firewall-rules create "$FW_NAME" \
            --project="$PROJECT_ID" \
            --network="$VPC_NETWORK" \
            --direction=INGRESS \
            --action=ALLOW \
            --rules="tcp:$SAP_PORT,tcp:443" \
            --source-ranges="$PSC_SUBNET_RANGE" \
            --destination-ranges="$SAP_HOST/32" \
            --description="Allow Agent Engine PSC traffic to SAP gateway"
    fi
else
    echo -e "${YELLOW}SAP_HOST empty — skipping SAP firewall rule (set SAP_HOST in .env.agent-engine)${NC}"
fi

# ---- 6. Cloud SQL Private IP firewall (PSC subnet → Cloud SQL) ----
# Cloud SQL Private IP is reachable via service networking peering once
# the PSA range is established by setup-cloud-sql.sh. No additional
# firewall rule is needed in the customer VPC — peered ranges have
# implicit allow. Documented here for clarity.

# ---- 7. Staging bucket ----
if gsutil ls -b "gs://$STAGING_BUCKET_NAME" >/dev/null 2>&1; then
    echo -e "${YELLOW}Staging bucket gs://$STAGING_BUCKET_NAME already exists${NC}"
else
    echo -e "${BLUE}Creating staging bucket gs://$STAGING_BUCKET_NAME...${NC}"
    gsutil mb -l "$REGION" "gs://$STAGING_BUCKET_NAME"
fi

# ---- 8. Secret Manager ----
for SECRET in "$SAP_CREDENTIALS_SECRET" "$SAP_CRED_ENCRYPTION_KEY_SECRET"; do
    if gcloud secrets describe "$SECRET" --project="$PROJECT_ID" >/dev/null 2>&1; then
        echo -e "${YELLOW}Secret $SECRET already exists${NC}"
    else
        echo -e "${BLUE}Creating secret $SECRET...${NC}"
        gcloud secrets create "$SECRET" \
            --project="$PROJECT_ID" \
            --replication-policy="automatic"
    fi
done

# ---- Summary ----
NETWORK_ATTACHMENT_PATH="projects/${PROJECT_ID}/regions/${REGION}/networkAttachments/${NETWORK_ATTACHMENT_NAME}"
echo ""
echo "=============================================="
echo -e "${GREEN}Agent Engine prerequisites ready${NC}"
echo "=============================================="
echo "Service account:    $SA_EMAIL"
echo "Network attachment: $NETWORK_ATTACHMENT_PATH"
echo "Staging bucket:     gs://$STAGING_BUCKET_NAME"
echo ""
echo "Add credentials to Secret Manager (example for OAuth):"
cat <<EOF
  echo '{
    "auth_type": "sap_oauth",
    "host": "${SAP_HOST:-<sap-host>}",
    "port": ${SAP_PORT},
    "client": "${SAP_CLIENT:-100}",
    "verify_ssl": ${SAP_VERIFY_SSL:-true},
    "oauth_client_id": "<id>",
    "oauth_client_secret": "<secret>",
    "oauth_token_url": "https://${SAP_HOST:-<sap-host>}:${SAP_PORT}/sap/bc/sec/oauth2/token?sap-client=${SAP_CLIENT:-100}",
    "oauth_authorize_url": "https://${SAP_HOST:-<sap-host>}:${SAP_PORT}/sap/bc/sec/oauth2/authorize?sap-client=${SAP_CLIENT:-100}"
  }' | gcloud secrets versions add ${SAP_CREDENTIALS_SECRET} --data-file=-

  python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" \\
    | gcloud secrets versions add ${SAP_CRED_ENCRYPTION_KEY_SECRET} --data-file=-
EOF
echo ""
echo "Then deploy the OAuth callback Cloud Run service and the agent:"
echo "  gcloud run deploy sap-oauth-callback --source ./cloud-run-oauth-callback --region $REGION --allow-unauthenticated"
echo "  python deploy/deploy-agent-engine.py --project $PROJECT_ID"
