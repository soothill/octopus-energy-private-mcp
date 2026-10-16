#!/usr/bin/env bash
# Append keys from .env.example that are missing from .env.
# Existing keys/values in .env are never modified.
set -euo pipefail
EXAMPLE="${1:-.env.example}"
ENV="${2:-.env}"
added=0
section=""
pending_section=""
while IFS= read -r line; do
  case "$line" in
    "# ---"*) pending_section="$line"; continue ;;
  esac
  key="${line%%=*}"
  [[ "$line" =~ ^[A-Za-z0-9_]+= ]] || continue
  if ! grep -q "^${key}=" "$ENV"; then
    if [[ -n "$pending_section" && "$pending_section" != "$section" ]]; then
      section="$pending_section"
      printf '\n%s\n' "$section" >> "$ENV"
    fi
    printf '%s\n' "$line" >> "$ENV"
    added=$((added+1))
  fi
done < "$EXAMPLE"
echo "merged $added missing key(s) from $EXAMPLE into $ENV"
