# Build stage
FROM node:22-slim AS builder

# Install pnpm
RUN npm install -g pnpm

WORKDIR /app

# Copy package files and patches
COPY package.json pnpm-lock.yaml* ./
COPY patches ./patches

# Install dependencies
RUN pnpm install

# Cache bust argument - change to force full rebuild
ARG CACHEBUST=1

# Copy source code
COPY . .

# Build the application
RUN pnpm run build

# Production stage
FROM node:22-slim

WORKDIR /app

# Install pnpm for production
RUN npm install -g pnpm

# Copy built files and necessary assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml* ./
COPY --from=builder /app/patches ./patches
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/server ./server
COPY --from=builder /app/shared ./shared

# Install all dependencies (required because build-time plugins are referenced in runtime)
RUN pnpm install

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Start the application
CMD ["pnpm", "start"]
