#!/bin/sh
set -eu

cd "$(dirname "$0")/../runtime"
mkdir -p bin/linux-amd64 bin/linux-arm64

for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build \
    -trimpath \
    -ldflags "-s -w -X main.runtimeVersion=${STACKBRIDGE_RUNTIME_VERSION:-0.2.0-dev}" \
    -o "bin/linux-$arch/stackbridge-runtime" \
    ./cmd/stackbridge-runtime
done

amd64_sha="$(sha256sum bin/linux-amd64/stackbridge-runtime | awk '{print $1}')"
arm64_sha="$(sha256sum bin/linux-arm64/stackbridge-runtime | awk '{print $1}')"
cat > bin/manifest.json <<EOF
{
  "schemaVersion": 1,
  "runtimeVersion": "${STACKBRIDGE_RUNTIME_VERSION:-0.2.0-dev}",
  "protocolVersion": 2,
  "artifacts": [
    { "platform": "linux", "arch": "amd64", "file": "linux-amd64/stackbridge-runtime", "sha256": "sha256:$amd64_sha" },
    { "platform": "linux", "arch": "arm64", "file": "linux-arm64/stackbridge-runtime", "sha256": "sha256:$arm64_sha" }
  ]
}
EOF
