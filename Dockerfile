# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lockb .npmrc /temp/dev/
ENV NPM_TOKEN=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
RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lockb /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# [optional] tests & build
ENV NODE_ENV=production
# RUN bun test
# RUN bun run build

# copy production dependencies and source code into final image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app .

# Set environment variables for Datadog
ENV DD_SERVICE=perennial-solver-ts \
    DD_ENV=prod \
    DD_VERSION=1.0.0 \
    DD_LOGS_INJECTION=true \
    DD_TRACE_ENABLED=true \
    DD_RUNTIME_METRICS_ENABLED=true
# run the app
RUN chown -R bun:bun .
USER bun
EXPOSE 8080
ENTRYPOINT [ "bun", "run", "index.ts" ]
