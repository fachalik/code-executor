FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
# `typescript` is a runtime dependency, not a build tool: it transpiles
# submitted TS inside the sandbox, so it must survive --omit=dev.
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist

# Nothing here needs to write to disk or reach the network. The sandbox already
# denies both to guest code; dropping them at the container level too means a
# flaw in this process has nowhere to go either.
USER node

EXPOSE 3002
CMD ["node", "dist/index.js"]
