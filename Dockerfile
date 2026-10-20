# The pool server: Node with no dependencies, so the image is the runtime and
# the source and nothing else.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web
COPY bin ./bin

# the accounts store and the clock-free state live here
ENV NODE_ENV=production \
    QODER_CLIENT_HOME=/data

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bin/qoder-client.js", "serve", "--host", "0.0.0.0", "--port", "8787"]
