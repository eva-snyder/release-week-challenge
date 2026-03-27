# Build frontend, then run API + static SPA from one process.
FROM node:20-bookworm-slim AS web-build
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY backend/src ./src
COPY --from=web-build /build/web/dist ./web/dist
ENV WEB_DIST_PATH=/app/web/dist
ENV PORT=8787
EXPOSE 8787
CMD ["node", "src/server.js"]
