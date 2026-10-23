# Imagen para Railway, Render, Fly.io o cualquier servicio con Docker
FROM node:22-slim
ENV NODE_ENV=production TZ=America/Santiago DATA_DIR=/data
WORKDIR /app
COPY . .
RUN rm -rf data
EXPOSE 3000
CMD ["node", "--no-warnings=ExperimentalWarning", "server.js"]
