#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go -C agent build -trimpath -ldflags='-s -w' -o "bin/linux-$arch/corematrix-agent" .
done
