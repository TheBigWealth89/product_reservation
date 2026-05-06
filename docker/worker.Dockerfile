# --- Background Workers Dockerfile ---
# Stage 1: Build & Dependencies
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first
COPY package*.json ./

# Install all dependencies
RUN npm ci

# Copy the rest of the application code
COPY . .

# Stage 2: Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Copy only necessary files
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/*.lua ./

# Install only production dependencies
RUN npm ci --only=production

# Workers do not expose ports by default
# Start the worker directly with node
CMD ["node", "src/workers/fulfillOrderWorker.js"]
