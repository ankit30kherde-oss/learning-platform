# ---------------------------------------------------------------------------
# The image a student actually gets a shell in.
#
# Rules this image follows, and why:
#   - no package manager left usable by the lab user (no `apk add` as a way to
#     pull a reverse shell in)
#   - no curl/wget/nc: with egress denied they are useless anyway, and their
#     absence removes the first thing an attacker reaches for
#   - a real non-root user with a home directory, so `whoami` and `~` behave
#   - util-linux `script`, which is how we get a pty without node-pty
# ---------------------------------------------------------------------------
FROM alpine:3.20

RUN apk add --no-cache \
      bash \
      coreutils \
      findutils \
      grep \
      sed \
      gawk \
      less \
      nano \
      vim \
      procps \
      util-linux \
      tree \
      jq \
 && addgroup -g 1000 labuser \
 && adduser -D -u 1000 -G labuser -h /home/labuser -s /bin/bash labuser \
 && rm -f /sbin/apk /usr/bin/wget \
 && rm -rf /var/cache/apk/*

COPY --chown=labuser:labuser exercises/ /home/labuser/exercises/

USER 1000:1000
WORKDIR /home/labuser
ENV HOME=/home/labuser \
    TERM=xterm-256color \
    PS1='lab:\w\$ '

CMD ["sleep", "3600"]
