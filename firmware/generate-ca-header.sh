#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_FILE="${ROOT_DIR}/firmware/certs/emqxsl-ca.crt"
SKETCH_DIR="${ROOT_DIR}/firmware/cuspnode_mq135"
OUTPUT_FILE="${SKETCH_DIR}/emqx_ca.h"
mkdir -p "${SKETCH_DIR}"

if [[ ! -s "${CERT_FILE}" ]]; then
  echo "CA certificate not found: ${CERT_FILE}" >&2
  exit 1
fi

if ! grep -q '^-----BEGIN CERTIFICATE-----$' "${CERT_FILE}" ||
   ! grep -q '^-----END CERTIFICATE-----$' "${CERT_FILE}"; then
  echo "Invalid PEM certificate: ${CERT_FILE}" >&2
  exit 1
fi

{
  printf '%s\n' '#pragma once' '#include <Arduino.h>' ''
  printf '%s\n' '// Generated from firmware/certs/emqxsl-ca.crt. Do not edit by hand.'
  printf '%s\n' 'static const char EMQX_ROOT_CA[] PROGMEM = R"EMQXCA('
  cat "${CERT_FILE}"
  printf '%s\n' ')EMQXCA";'
} > "${OUTPUT_FILE}"

echo "Generated firmware/cuspnode_mq135/emqx_ca.h"
