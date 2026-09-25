#!/usr/bin/env bash
set -Eeuo pipefail

ENDPOINT="${S3_ENDPOINT:-http://localhost:9000}"
BUCKET="${MEDIA_BUCKET:-lp-media-dev}"
KEY="${S3_ACCESS_KEY:-minioadmin}"
SECRET="${S3_SECRET_KEY:-minioadmin}"
REGION="${AWS_REGION:-us-east-1}"

echo "[S3] Endpoint: ${ENDPOINT}"
echo "[S3] Bucket:   ${BUCKET}"

aws_s3() {
  docker run --rm \
    --network host \
    -e "AWS_ACCESS_KEY_ID=${KEY}" \
    -e "AWS_SECRET_ACCESS_KEY=${SECRET}" \
    -e "AWS_DEFAULT_REGION=${REGION}" \
    amazon/aws-cli:latest \
    --endpoint-url "${ENDPOINT}" \
    "$@"
}

echo "[S3] Waiting for S3 endpoint..."

for attempt in {1..30}; do
  if aws_s3 s3api list-buckets >/dev/null 2>&1; then
    echo "[S3] S3 endpoint is ready."
    break
  fi

  if [ "$attempt" -eq 30 ]; then
    echo "[S3][ERROR] S3 endpoint did not become ready."
    exit 1
  fi

  echo "[S3] Waiting... ${attempt}/30"
  sleep 2
done

echo "[S3] Checking bucket..."

if aws_s3 s3api head-bucket --bucket "${BUCKET}" >/dev/null 2>&1; then
  echo "[S3] Bucket already exists: ${BUCKET}"
else
  echo "[S3] Creating bucket: ${BUCKET}"
  aws_s3 s3 mb "s3://${BUCKET}"
fi

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

printf 'placeholder' > "$TMP_FILE"

echo "[S3] Uploading placeholder video..."

docker run --rm \
  --network host \
  -v "${TMP_FILE}:/tmp/placeholder.bin:ro" \
  -e "AWS_ACCESS_KEY_ID=${KEY}" \
  -e "AWS_SECRET_ACCESS_KEY=${SECRET}" \
  -e "AWS_DEFAULT_REGION=${REGION}" \
  amazon/aws-cli:latest \
  --endpoint-url "${ENDPOINT}" \
  s3 cp \
  /tmp/placeholder.bin \
  "s3://${BUCKET}/courses/devops-sre-engineering/welcome-and-how-to-use-this-course.mp4"

echo "[S3] Uploading placeholder PDF..."

docker run --rm \
  --network host \
  -v "${TMP_FILE}:/tmp/placeholder.bin:ro" \
  -e "AWS_ACCESS_KEY_ID=${KEY}" \
  -e "AWS_SECRET_ACCESS_KEY=${SECRET}" \
  -e "AWS_DEFAULT_REGION=${REGION}" \
  amazon/aws-cli:latest \
  --endpoint-url "${ENDPOINT}" \
  s3 cp \
  /tmp/placeholder.bin \
  "s3://${BUCKET}/courses/devops-sre-engineering/notes/linux-cheatsheet.pdf"

echo "[S3] Verifying objects..."

aws_s3 s3 ls "s3://${BUCKET}/" --recursive

echo
echo "[S3] Bootstrap completed successfully."
