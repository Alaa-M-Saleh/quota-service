FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY client ./client
COPY perf ./perf
COPY web ./web
COPY migrations ./migrations
COPY tests ./tests
COPY vitest.config.ts ./
RUN npm run build

FROM build AS test
CMD ["npm", "test"]

FROM build AS production-deps
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/web/public ./web/public
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
