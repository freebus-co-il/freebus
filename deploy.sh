#!/usr/bin/env bash
#
# Update the running stack, then reclaim what the rebuild orphaned.
#
# Why this exists rather than just `docker compose up -d --build`:
# all three built services carry a FIXED tag (freebus/api:latest,
# freebus/gtfs:latest, freebus/photon:latest). Every rebuild moves
# that tag onto a new image and leaves the previous one untagged — a
# `<none>:<none>` image that nothing ever reclaims. On a 40 GB box, roughly
# 300 MB leaks per api deploy and about 1 GB when all three rebuild,
# so a few dozen deploys are enough to matter. BuildKit's cache grows on top
# of that whenever a package-lock changes.
#
# What is deliberately NOT done here:
#   * `docker system prune -a` — would also delete the pulled valhalla and
#     caddy images, forcing a slow re-pull on the next restart for no gain.
#   * anything touching volumes — the Valhalla tiles (524 MB), the Photon
#     index (206 MB) and the GTFS feed live on named volumes. `--volumes`
#     would destroy hours of rebuild work. Never add it.
#
set -euo pipefail

cd "$(dirname "$0")"

# Find the daemon before doing anything that needs it.
#
# Under ROOTLESS Docker the socket lives in the invoking user's runtime
# directory rather than at /var/run/docker.sock, and a forced-command SSH
# session -- which is how CI runs this -- does not reliably inherit
# XDG_RUNTIME_DIR. Without this, `docker compose` here fails with "Cannot
# connect to the Docker daemon" even though the daemon is running fine for
# an interactive login.
#
# Deliberately conditional on the socket EXISTING: on a rootful box there is
# no such file, DOCKER_HOST stays unset, and docker falls back to
# /var/run/docker.sock exactly as before. Safe to have in place before any
# rootless migration, and safe to leave if one never happens.
if [ -z "${DOCKER_HOST:-}" ]; then
  _runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  if [ -S "$_runtime_dir/docker.sock" ]; then
    export DOCKER_HOST="unix://$_runtime_dir/docker.sock"
    echo "==> rootless daemon at $DOCKER_HOST"
  fi
fi

avail() { df -h . | awk 'NR==2 {print $4}'; }

echo "==> disk before: $(avail) free"

git pull --ff-only

# GEOCODER decides who answers address SEARCH. It no longer decides whether
# Photon exists: Photon answers /geocode/reverse in both modes (see
# api/src/geocode/composite.ts), so it is built and started either way.
# Read through compose itself, so the default in docker-compose.yml and
# whatever .env interpolates apply exactly as `up` will see them.
read -r GEOCODER GOOGLE_KEY_SET < <(docker compose config --format json | python3 -c "
import json, sys
env = json.load(sys.stdin)['services']['api']['environment']
print(env.get('GEOCODER') or 'photon', 'yes' if env.get('GOOGLE_MAPS_API_KEY') else 'no')
") || true

case "${GEOCODER:-}" in
  photon)
    ;;
  google)
    # Checked HERE, before anything restarts: api refuses to boot
    # without the key, and that would take /plan down along with search.
    if [ "$GOOGLE_KEY_SET" != yes ]; then
      echo "!! GEOCODER=google but GOOGLE_MAPS_API_KEY is empty in .env -- nothing was restarted" >&2
      exit 1
    fi
    ;;
  *)
    echo "!! GEOCODER must be 'photon' or 'google', got '${GEOCODER:-}' -- nothing was restarted" >&2
    exit 1
    ;;
esac
# Emptied deliberately, and NOT left to .env: an older .env on this box still
# carries `COMPOSE_PROFILES=${GEOCODER}` from when Photon sat behind a profile.
# Photon no longer declares one, so that value now names a profile nothing
# uses -- harmless for Photon, but it would silently activate any profile a
# future service happens to name `google` or `photon`. Clearing it here keeps
# `up` reading exactly the services in the compose file.
export COMPOSE_PROFILES=
echo "==> search geocoder: $GEOCODER (reverse always: photon)"

# --remove-orphans: a service deleted from the compose file otherwise keeps
# running forever, holding its image and its port.
docker compose up -d --build --remove-orphans

# Dangling images only: these are exactly the ones the rebuild above just
# orphaned. Tagged images (valhalla, caddy, the current freebus/*) are
# untouched.
echo "==> reclaiming orphaned images"
docker image prune -f

# Cap the build cache rather than emptying it — an empty cache makes the
# next `npm ci` layer rebuild from scratch, which is the slowest part of a
# deploy. Entries untouched for a week are not helping anyone.
echo "==> trimming build cache older than 7 days"
docker builder prune -f --filter until=168h

echo "==> disk after: $(avail) free"

# The API answers /health as soon as it is listening, but /ready stays 503
# until the RAPTOR index is built — that is the one worth waiting on.
echo "==> waiting for /ready"
for _ in $(seq 1 60); do
  if curl -fsS -m 5 http://localhost:3100/ready >/dev/null 2>&1; then
    echo "==> ready"
    # Shell double quotes outside, single quotes inside, and no f-string:
    # nothing here needs escaping, and it runs on any Python 3.
    curl -fsS -m 5 http://localhost:3100/meta | python3 -c "
import json, sys
m = json.load(sys.stdin)
r = m['realtime']
seen = r['resolved'] + r['unresolved']
print('    feed', m['version'])
print('    realtime', r['health'], '/', r.get('source'), '--',
      str(r['resolved']) + '/' + str(seen), 'resolved')
" || true
    exit 0
  fi
  sleep 5
done

echo "!! /ready did not come up within 5 minutes — check: docker compose logs -f api" >&2
exit 1
