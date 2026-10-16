FROM node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod 755 /usr/sbin/policy-rc.d \
    && apt-get update \
    && apt-get install --no-install-recommends -y systemd openssl \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/local/bin/node /usr/bin/node \
    && groupadd --gid 1001 corematrix \
    && useradd --uid 1001 --gid 1001 --no-create-home --home-dir /var/lib/corematrix --shell /usr/sbin/nologin corematrix
# This image only supplies offline validation tools; it never starts systemd or mounts Docker's socket.
WORKDIR /opt/corematrix/current
