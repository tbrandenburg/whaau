FROM node:20-alpine AS final
WORKDIR /app
ENV NODE_ENV=production
COPY index.js ./
USER node
CMD ["node", "index.js"]
