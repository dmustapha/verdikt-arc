# Reference-seller service — a persistent Node process (the deliver-then-settle lifecycle acks 202 then
# works asynchronously, so this must be a long-running host, not a serverless function).
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
ENV PORT=8080
EXPOSE 8080
CMD ["npx", "tsx", "src/server.ts"]
