FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Kolkata
RUN apk add --no-cache tzdata
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
USER node
EXPOSE 8092
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8092/healthz >/dev/null || exit 1
CMD ["node", "src/server.mjs"]
