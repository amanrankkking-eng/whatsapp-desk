# Evolution API 2.3.7 with the three patches WhatsApp Desk depends on:
#   1. evolution-group-metadata.patch  - groups sync in one WhatsApp query (no rate-overlimit storms)
#   2. evolution-group-receipts.patch  - per-member delivered/read receipts are stored (group ticks)
#   3. baileys+7.0.0-rc14.patch        - answers companion_reg_refresh, so QR linking works again
#                                        (Evolution PR #2727, not merged when this was built)
# Verified on 28 Sep 2026: all three apply cleanly to a fresh 2.3.7 clone and the build passes.
FROM node:22-alpine AS builder
RUN apk add --no-cache git ffmpeg wget curl bash openssl dos2unix patch
WORKDIR /evolution
ARG EVOLUTION_REF=2.3.7
RUN git clone --depth 1 --branch ${EVOLUTION_REF} https://github.com/EvolutionAPI/evolution-api.git .
COPY patches /patches
RUN patch -p1 < /patches/evolution-group-metadata.patch \
 && patch -p1 < /patches/evolution-group-receipts.patch \
 && npm pkg set dependencies.baileys=7.0.0-rc14 \
 && npm install --no-audit --no-fund --loglevel=error \
 && patch -p1 < /patches/baileys+7.0.0-rc14.patch
RUN cp .env.example .env \
 && chmod +x ./Docker/scripts/* && dos2unix ./Docker/scripts/* \
 && ./Docker/scripts/generate_database.sh \
 && npm run build

FROM node:22-alpine AS final
RUN apk add --no-cache tzdata ffmpeg bash openssl
ENV TZ=Asia/Kolkata
ENV DOCKER_ENV=true
WORKDIR /evolution
COPY --from=builder /evolution/package.json ./package.json
COPY --from=builder /evolution/package-lock.json ./package-lock.json
COPY --from=builder /evolution/node_modules ./node_modules
COPY --from=builder /evolution/dist ./dist
COPY --from=builder /evolution/prisma ./prisma
COPY --from=builder /evolution/manager ./manager
COPY --from=builder /evolution/public ./public
COPY --from=builder /evolution/.env ./.env
COPY --from=builder /evolution/Docker ./Docker
COPY --from=builder /evolution/runWithProvider.js ./runWithProvider.js
COPY --from=builder /evolution/tsup.config.ts ./tsup.config.ts
EXPOSE 8080
ENTRYPOINT ["/bin/bash", "-c", ". ./Docker/scripts/deploy_database.sh && npm run start:prod"]
