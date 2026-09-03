# syntax=docker/dockerfile:1.6

# Stage 1 — build frontend
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2 — runtime (minimal)
FROM node:22-alpine
RUN apk add --no-cache rclone sshpass openssh-client ca-certificates tini tzdata su-exec
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
 && addgroup -S app && adduser -S app -G app \
 && mkdir -p /app/data && chown -R app:app /app \
 && chmod +x /app/docker-entrypoint.sh
# data lives in a volume, not in the image.
# The entrypoint starts as root only to chown a pre-existing root-owned
# volume (created by ≤2.0.x images), then drops to the `app` user.
VOLUME ["/app/data"]
EXPOSE 8765
ENV HOST=0.0.0.0 PORT=8765 NODE_ENV=production TZ=Asia/Kolkata
ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
