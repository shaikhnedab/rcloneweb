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
RUN apk add --no-cache rclone sshpass openssh-client ca-certificates tini tzdata
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
 && addgroup -S app && adduser -S app -G app \
 && mkdir -p /app/data && chown -R app:app /app
# data lives in a volume, not in the image
VOLUME ["/app/data"]
USER app
EXPOSE 8765
ENV HOST=0.0.0.0 PORT=8765 NODE_ENV=production TZ=Asia/Kolkata
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
