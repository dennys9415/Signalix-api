# Build context must be the monorepo root (proyect/) so both
# Signalix-contracts and Signalix-api are available.
# docker build -f Signalix-api/Dockerfile -t signalix-api .

FROM node:22-alpine AS builder

WORKDIR /workspace

# --- contracts ---
COPY Signalix-contracts/package*.json ./Signalix-contracts/
RUN cd Signalix-contracts && npm ci

COPY Signalix-contracts/ ./Signalix-contracts/
RUN cd Signalix-contracts && npm run build

# --- api ---
COPY Signalix-api/package*.json ./Signalix-api/
RUN cd Signalix-api && npm ci

COPY Signalix-api/tsconfig.json ./Signalix-api/
COPY Signalix-api/src ./Signalix-api/src
RUN cd Signalix-api && npm run build

# Prune dev deps, then replace the file: symlink with the compiled dist so
# the runtime image does not need the contracts source tree.
RUN cd Signalix-api && npm prune --omit=dev
RUN rm -f /workspace/Signalix-api/node_modules/@signalix/contracts \
 && mkdir -p /workspace/Signalix-api/node_modules/@signalix/contracts \
 && cp /workspace/Signalix-contracts/package.json \
       /workspace/Signalix-api/node_modules/@signalix/contracts/ \
 && cp -r /workspace/Signalix-contracts/dist \
          /workspace/Signalix-api/node_modules/@signalix/contracts/dist

# --- runtime ---
FROM node:22-alpine

WORKDIR /app

COPY --from=builder /workspace/Signalix-api/node_modules ./node_modules
COPY --from=builder /workspace/Signalix-api/dist ./dist
COPY --from=builder /workspace/Signalix-api/package.json ./package.json

EXPOSE 4000

CMD ["node", "dist/main.js"]
