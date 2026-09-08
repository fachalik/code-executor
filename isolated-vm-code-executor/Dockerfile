# `isolated-vm` is a native addon compiled against V8's headers, so this image
# is Debian rather than Alpine: node-gyp needs a real toolchain, and the musl
# build of the addon is not a path worth debugging for a sandbox.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# The compiled addon travels with node_modules from the deps stage. Rebuilding
# it here would mean shipping the toolchain in the runtime image; pruning the
# dev packages out of the existing tree keeps the .node binary and drops the rest.
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev
COPY --from=builder /app/dist ./dist

# Nothing here needs to write to disk or reach the network. An isolate has no
# Node bindings at all, so guest code cannot try; dropping both at the container
# level means a flaw in *this* process has nowhere to go either.
USER node

EXPOSE 3003

# --no-node-snapshot is required: Node 20 boots from a V8 startup snapshot that
# isolated-vm cannot attach to, and the process aborts on the first isolate
# without it.
CMD ["node", "--no-node-snapshot", "dist/index.js"]
