FROM node:22-alpine
WORKDIR /app
# The commit this image was built from; every recorded error carries it.
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production TZ=Asia/Kolkata GIT_COMMIT=$GIT_COMMIT
RUN apk add --no-cache tzdata
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
USER node
EXPOSE 8092
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- 'http://127.0.0.1:8092/healthz?self=1' >/dev/null || exit 1
CMD ["node", "src/server.mjs"]
