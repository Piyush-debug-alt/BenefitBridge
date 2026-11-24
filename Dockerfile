FROM node:24-bookworm-slim AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json

FROM manifests AS frontend
RUN npm ci --workspace web --include=dev
COPY web/ web/
RUN npm run build -w web -- --mode demo

FROM manifests AS runtime
ENV NODE_ENV=production
RUN npm ci --workspace api --omit=dev
COPY api/src/ api/src/
COPY api/test/fixtures/synthetic/catalogue.json api/test/fixtures/synthetic/catalogue.json
COPY --from=frontend /app/web/dist/ web/dist/
USER node
CMD ["node", "api/src/server.js", "--render-demo"]
