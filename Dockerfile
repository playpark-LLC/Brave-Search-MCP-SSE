FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci -p

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

FROM node:18-alpine AS runner
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Expose port for SSE
EXPOSE 3001

# Start the server
CMD ["npm", "start"]
