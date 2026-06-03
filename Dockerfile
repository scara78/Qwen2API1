# Stage 1: Build & Production Install
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# Stage 2: Minimalist Lightweight Production Image
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy only production dependencies and source files
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src
COPY frontend/ ./frontend

# Create empty data directory for volume mounting
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "src/index.js"]
