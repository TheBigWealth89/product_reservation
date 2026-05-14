# --- API Server Dockerfile ---
# Stage 1: Build & Dependencies
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first
COPY package*.json ./

# Install all dependencies (including devDependencies for any build steps)
RUN npm ci

# Copy the rest of the application code
COPY . .

# Prune devDependencies for a smaller production image
RUN npm prune --production

# Stage 2: Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Copy package files
COPY --from=builder /app/package*.json ./

# Copy production node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY --from=builder /app/src ./src

# Copy any lua scripts if they exist (used by Redis/BullMQ)
COPY --from=builder /app/*.lua ./

# API Server runs on 3000
EXPOSE 3000

# Start the API server directly with node
CMD ["node", "src/server.js"]
