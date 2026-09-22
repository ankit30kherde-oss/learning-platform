#!/usr/bin/env bash
# Creates the media bucket in MinIO and drops in a sample video and PDF so the
# player and the downloads panel have something real to sign.
#
# The bucket is left PRIVATE on purpose: if you can fetch an object without a
# signature, the whole protected-media design is decorative.
set -euo pipefail

ENDPOINT="${S3_ENDPOINT:-http://localhost:9000}"
BUCKET="${MEDIA_BUCKET:-lp-media-dev}"
KEY="${S3_ACCESS_KEY:-minioadmin}"
SECRET="${S3_SECRET_KEY:-minioadmin}"

if ! command -v mc >/dev/null 2>&1; then
  echo "minio client (mc) not found - skipping bucket bootstrap."
  echo "The app still runs; video playback will return a signing error until a bucket exists."
  echo "Install: https://min.io/docs/minio/linux/reference/minio-mc.html"
  exit 0
fi

mc alias set lpdev "$ENDPOINT" "$KEY" "$SECRET" >/dev/null
mc mb --ignore-existing "lpdev/${BUCKET}" >/dev/null
echo "bucket ready: ${BUCKET} (private)"

# A tiny placeholder so the player has bytes to fetch.
tmp=$(mktemp -d)
printf 'placeholder' > "$tmp/placeholder.bin"
mc cp --quiet "$tmp/placeholder.bin" "lpdev/${BUCKET}/courses/devops-sre-engineering/welcome-and-how-to-use-this-course.mp4" >/dev/null || true
mc cp --quiet "$tmp/placeholder.bin" "lpdev/${BUCKET}/courses/devops-sre-engineering/notes/linux-cheatsheet.pdf" >/dev/null || true
rm -rf "$tmp"
echo "seeded placeholder objects"
