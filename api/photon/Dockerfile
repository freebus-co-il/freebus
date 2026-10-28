# No official Photon image exists (the project ships a plain jar, Java 21+
# required since Photon 1.0 -- OpenSearch is a hard dependency, not
# optional). The one community wrapper this stack tried
# (rtuszik/photon-docker) only offers prebuilt indexes for a fixed list of
# countries that does NOT include Israel, and its jsonl mode is similarly
# restricted to that same fixed region list with no custom-extract option --
# see the entrypoint's own comment for how this image instead builds a
# small, Israel-only index itself.
FROM eclipse-temurin:21-jre-jammy

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl zstd ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /photon

# Pinned: an unpinned "latest" jar would silently change the on-disk index
# format out from under an already-imported ./photon-data volume.
ARG PHOTON_VERSION=1.3.0
RUN curl -fL -o photon.jar \
    "https://github.com/komoot/photon/releases/download/${PHOTON_VERSION}/photon-${PHOTON_VERSION}.jar"

COPY entrypoint.sh /photon/entrypoint.sh
RUN chmod +x /photon/entrypoint.sh

ENTRYPOINT ["/photon/entrypoint.sh"]
