# Minimal Alpine SSH fixture (~30 MB) with vim, tmux, and fish for smoke tests.
# Requires tests/fixtures/keys/smoke.pub — run: bash tests/fixtures/generate-keys.sh
FROM alpine:3.21

RUN apk add --no-cache \
    bash \
    fish \
    netcat-openbsd \
    openssh \
    tmux \
    vim \
  && mkdir -p /var/run/sshd /run/sshd /etc/ssh/authorized_keys.d \
  && ssh-keygen -A \
  && adduser -D -s /bin/bash test \
  && echo 'test:fixture-account-unlocked' | chpasswd \
  && grep -Eq '^test:[^!:]' /etc/shadow

COPY sshd_config /etc/ssh/sshd_config
COPY keys/smoke.pub /etc/ssh/authorized_keys.d/test
RUN chmod 644 /etc/ssh/authorized_keys.d/test \
  && /usr/sbin/sshd -t -f /etc/ssh/sshd_config \
  && grep -q 'gosh-smoke-fixture' /etc/ssh/authorized_keys.d/test

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 2222
ENTRYPOINT ["/entrypoint.sh"]
