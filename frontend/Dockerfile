FROM node:20-alpine AS builder

WORKDIR /app

COPY shared/package.json ./shared/
COPY frontend/package.json frontend/package-lock.json* ./frontend/
COPY frontend/scripts/ ./frontend/scripts/

WORKDIR /app/frontend
RUN npm ci

COPY shared/ ../shared/
COPY frontend/ .

ARG NEXT_PUBLIC_BACKEND_URL=http://localhost:3001
ARG NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws
ARG NEXT_PUBLIC_DEBUG=false
ARG NEXT_PUBLIC_BARGE_IN_MIN_CHARS=5
ARG NEXT_PUBLIC_EARLY_BARGE_IN_MIN_CHARS=2
ARG NEXT_PUBLIC_WAITING_THRESHOLD=1000
ARG NEXT_PUBLIC_POST_WAITING_DELAY=400

ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_DEBUG=$NEXT_PUBLIC_DEBUG
ENV NEXT_PUBLIC_BARGE_IN_MIN_CHARS=$NEXT_PUBLIC_BARGE_IN_MIN_CHARS
ENV NEXT_PUBLIC_EARLY_BARGE_IN_MIN_CHARS=$NEXT_PUBLIC_EARLY_BARGE_IN_MIN_CHARS
ENV NEXT_PUBLIC_WAITING_THRESHOLD=$NEXT_PUBLIC_WAITING_THRESHOLD
ENV NEXT_PUBLIC_POST_WAITING_DELAY=$NEXT_PUBLIC_POST_WAITING_DELAY

RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app/frontend

ENV NODE_ENV=production

COPY --from=builder /app/frontend/package.json ./
COPY --from=builder /app/frontend/node_modules ./node_modules
COPY --from=builder /app/frontend/.next ./.next
COPY --from=builder /app/frontend/public ./public

EXPOSE 3000

CMD ["npm", "start"]
