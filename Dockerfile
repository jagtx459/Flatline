# Flatline keeps npm dependencies to the minimum necessary (currently: ssh2,
# for real SSH command execution — Node has no built-in SSH client; yaml, for
# kubeconfig parsing; nodemailer, for SMTP email notifications) and has no
# build step. --ignore-scripts skips ssh2's
# optional native crypto addon (cpu-features), which needs a C toolchain;
# ssh2 falls back to pure JS, so no build tools are needed in the image.
#
# Security posture: the container runs as the unprivileged `node` user, not
# root. busybox ping needs raw sockets (root), so iputils-ping is installed
# instead and granted cap_net_raw via a file capability — that one binary can
# open ICMP sockets and nothing else in the container is privileged. libcap
# is only needed for the setcap call and is removed again.
FROM node:26-alpine

RUN apk add --no-cache iputils-ping \
 && apk add --no-cache libcap \
 && setcap cap_net_raw+ep "$(readlink -f "$(command -v ping)")" \
 && apk del libcap

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    PORT=3131 \
    FLATLINE_DATA_DIR=/data

RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3131
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3131/api/health || exit 1

CMD ["node", "server/index.js"]
