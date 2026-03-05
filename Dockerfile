# Multi-stage build for Arachne Gateway (Node.js/Fastify API)

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files for root
COPY package*.json ./

# Install root dependencies
RUN npm ci

# Copy source files
COPY src/ ./src/
COPY tsconfig.json ./
COPY migrations/ ./migrations/
COPY shared/ ./shared/

# Build TypeScript to JavaScript
RUN npm run build

# Build dashboard
WORKDIR /app/dashboard
COPY dashboard/package*.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# Build portal
WORKDIR /app/portal
COPY portal/package*.json ./
RUN npm ci
COPY portal/ ./
RUN npm run build

# Runtime stage
FROM node:20-alpine

WORKDIR /app

# Copy built artifacts and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dashboard/dist ./dashboard/dist
COPY --from=builder /app/portal/dist ./portal/dist

# Expose gateway port
EXPOSE 3000

# Start the gateway
CMD ["node", "dist/index.js"]
