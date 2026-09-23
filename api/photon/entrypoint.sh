#!/bin/bash
# bash, not /bin/sh (dash on this image): `set -o pipefail` below needs it.
# Without pipefail, `zstd | java import`'s exit status would be `java`'s
# alone -- a corrupt/truncated download that made `zstd` fail but left
# `java` reading a short, technically-parseable stream would go undetected,
# and the marker below would still get written over an incomplete index.
set -euo pipefail

# Builds a small, Israel-only Photon search index on first start, then
# serves it. Runs once: a completed import is marked by $MARKER, and every
# later container start skips straight to `serve` -- the same
# runs-once-then-reuses-the-volume shape as this stack's Valhalla service.
#
# WHY THIS EXISTS (not the published per-country prebuilt index):
# GraphHopper's per-country prebuilt Photon dumps ARE published for Israel
# (photon-db-il-*.tar.bz2), but they were built under Photon's old
# Elasticsearch backend. Photon 1.0 (2026-02) dropped Elasticsearch
# entirely -- OpenSearch only -- so a current Photon refuses that dump with
# "Data directory ... seems to be empty. Are you using an index for
# OpenSearch?", even though the files are genuinely there (verified by
# inspecting the container directly: the elasticsearch/ folder is fully
# populated). No newer, OpenSearch-format per-country Israel dump exists as
# of this writing. The community wrapper's jsonl import mode doesn't help
# either -- its REGION list covers whole continents/16 named countries
# (Israel isn't one) plus ~30 Europe-only regions, with no custom-extract
# option (`FILE_URL` is explicitly unsupported in that mode).
#
# So this builds the index itself, straight from Photon's own tooling:
# stream Photon's official Asia-continent jsonl dump (published by the
# Photon project itself, not a third party -- 2.79 GB compressed) through
# `photon.jar import -country-codes IL,PS`, which filters DURING import
# to the same area this stack's Valhalla service routes against (see the
# `valhalla` service above -- both read the same regional OSM extract).
# Narrowing `-country-codes` to a single code would silently drop addresses
# carrying the other one, which Valhalla will still happily walk-route to. The result is a small on-disk
# index, even though the download that produces it is continent-wide --
# Photon has no narrower official dump than "continent".
#
# The dump's own version tag ("1.0" in the URL below) is a DUMP SCHEMA
# version, not the same number as $PHOTON_VERSION in the Dockerfile (the
# actual Photon jar, currently 1.3.0) -- Photon's own docs describe the
# "1.0" dump as compatible with "Photon versions 0.7.x through 1.x", i.e. a
# wider range than one jar release. The two are NOT interpolated from one
# variable: bumping PHOTON_VERSION does not by itself require or imply
# bumping this URL, and this URL should be re-checked by hand against
# Photon's own release notes whenever PHOTON_VERSION crosses a boundary
# that changes the on-disk index format again (the way 1.0 crossed OpenSearch).
#
# VERIFIED END-TO-END (2026-08-24): the full pipeline -- download, decompress,
# country-code filtering, and a complete OpenSearch import -- succeeded and
# served correct real-world results in both English and Hebrew. It took
# ~12.5 minutes and peaked at ~1.0 GB RSS under a 2 vCPU / 2 GB cap (matching
# Photon's realistic share of the production box's resources alongside
# api/Valhalla/gtfs). Every earlier attempt on this same box failed at
# OpenSearch's 95% flood-stage disk watermark -- root-caused to the *host's*
# free disk being under ~10 GB, not this pipeline (OpenSearch checks the
# whole disk the data directory lives on, not just its own usage; the data
# directory was under 1 MB at every one of those failures). Freeing disk to
# ~43 GB free let the identical pipeline succeed on the very next retry. On
# a 40 GB box the 95%-of-whole-disk math only needs ~2 GB free to clear, so
# this shouldn't recur there -- but it's worth knowing the mechanism if it
# ever does: "flood stage disk watermark" in `docker logs` means free disk,
# not a code problem.
#
# The ~1 GB import-time RAM spike is real contention against the ~1.6 GB of
# headroom the rest of the stack leaves on a 4 GB box (see [[deployment-plan]]
# memory), which is why $PREBUILT_URL below exists: build the index ONCE
# (locally, or in CI -- see .github/workflows/build-photon-index.yml) and
# ship the finished ~205 MB result, so production never pays the import's
# CPU/RAM cost at all -- only the cheap ~550 MB steady-state `serve`.

DATA_DIR="${PHOTON_DATA_DIR:-/photon/data}"
DUMP_URL="${PHOTON_DUMP_URL:-https://download1.graphhopper.com/public/asia/photon-dump-asia-1.0-latest.jsonl.zst}"
COUNTRY_CODES="${PHOTON_COUNTRY_CODES:-IL,PS}"
LANGUAGES="${PHOTON_LANGUAGES:-en}"
JAVA_OPTS="${PHOTON_JAVA_OPTS:--Xmx768m}"
MARKER="$DATA_DIR/.import-complete"
# Coarse floor, not a precise expectation: a genuinely populated index is
# on the order of hundreds of MB (measured: 205 MB).
# A wrong/typo'd -country-codes, or a corrupt prebuilt tarball, that still
# "succeeds" with near-nothing on disk would otherwise write $MARKER over a
# near-empty index that then serves silent, permanent empty results forever
# -- indistinguishable from Photon simply having no match, at every layer
# above this script. This check turns that into a loud first-boot failure
# instead, for EITHER import path below.
MIN_INDEX_SIZE_MB="${PHOTON_MIN_INDEX_SIZE_MB:-20}"
# Set by .github/workflows/build-photon-index.yml: run the import (from
# whichever path below applies) and exit 0 immediately after, without ever
# starting `serve`. CI has no use for a running server -- it only wants the
# resulting $DATA_DIR to package up as the next release asset.
IMPORT_ONLY="${PHOTON_IMPORT_ONLY:-}"
# When set, this is a prebuilt index tarball (produced by the CI workflow
# above from a prior run of the full import below) to download and extract
# instead of running the expensive import ourselves -- the whole point of
# baking the index ahead of time. Expects a `.tar.zst` at this URL and a
# same-named `.sha256` file alongside it.
PREBUILT_URL="${PHOTON_PREBUILT_URL:-}"

if [ ! -f "$MARKER" ]; then
  # A prior attempt that was interrupted before reaching the marker below
  # (killed, OOM, disk-full) can leave a partial index in $DATA_DIR; that
  # partial state must not be merged into on retry, hence the wipe -- for
  # either import path below.
  rm -rf "${DATA_DIR:?}"/*
  mkdir -p "$DATA_DIR"

  if [ -n "$PREBUILT_URL" ]; then
    echo "No completed import marker at $MARKER -- downloading prebuilt index from $PREBUILT_URL"
    curl -fL -o /tmp/photon-index.tar.zst "$PREBUILT_URL"
    curl -fL -o /tmp/photon-index.tar.zst.sha256 "$PREBUILT_URL.sha256"
    (cd /tmp && echo "$(cat photon-index.tar.zst.sha256)  photon-index.tar.zst" | sha256sum -c -)
    tar --zstd -xf /tmp/photon-index.tar.zst -C "$DATA_DIR"
    rm -f /tmp/photon-index.tar.zst /tmp/photon-index.tar.zst.sha256
  else
    echo "No completed import marker at $MARKER -- importing $COUNTRY_CODES from $DUMP_URL"
    curl -fL -o /tmp/dump.jsonl.zst "$DUMP_URL"
    zstd -d --stdout /tmp/dump.jsonl.zst | java $JAVA_OPTS -jar /photon/photon.jar import \
      -import-file - -data-dir "$DATA_DIR" -country-codes "$COUNTRY_CODES" -languages "$LANGUAGES"
    rm -f /tmp/dump.jsonl.zst
  fi

  index_size_mb=$(du -sm "$DATA_DIR" | cut -f1)
  if [ "$index_size_mb" -lt "$MIN_INDEX_SIZE_MB" ]; then
    echo "FATAL: import exited successfully but $DATA_DIR is only ${index_size_mb}MB" \
      "(expected at least ${MIN_INDEX_SIZE_MB}MB) -- COUNTRY_CODES=$COUNTRY_CODES or the" \
      "prebuilt tarball likely produced nothing usable. Refusing to write the completion" \
      "marker over this." >&2
    exit 1
  fi

  touch "$MARKER"
  echo "Import complete (${index_size_mb}MB)."
else
  echo "Marker found at $MARKER -- skipping import"
fi

if [ -n "$IMPORT_ONLY" ]; then
  echo "PHOTON_IMPORT_ONLY set -- import finished, not starting serve."
  exit 0
fi

exec java $JAVA_OPTS -jar /photon/photon.jar serve -data-dir "$DATA_DIR" -listen-ip 0.0.0.0
