FROM node:22-bookworm-slim AS web-build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY public ./public
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM eclipse-temurin:17-jdk-jammy AS android-build
ARG ANDROID_COMMANDLINE_REV=11076708
ARG GRADLE_VERSION=8.9
ENV ANDROID_HOME=/opt/android-sdk
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && rm /tmp/gradle.zip \
    && ln -s "/opt/gradle-${GRADLE_VERSION}" /opt/gradle
RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
    && curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_COMMANDLINE_REV}_latest.zip" -o /tmp/android-cmdline.zip \
    && unzip -q /tmp/android-cmdline.zip -d /tmp/android-cmdline \
    && mkdir -p "$ANDROID_HOME/cmdline-tools/latest" \
    && mv /tmp/android-cmdline/cmdline-tools/* "$ANDROID_HOME/cmdline-tools/latest/" \
    && rm -rf /tmp/android-cmdline /tmp/android-cmdline.zip
ENV PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
RUN yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1 || true
RUN sdkmanager --sdk_root="$ANDROID_HOME" 'platforms;android-35' 'build-tools;35.0.0' 'platform-tools'
COPY android-template/MainActivity.java /opt/codexa/MainActivity.java
RUN mkdir -p /opt/codexa/classes \
    && javac -encoding UTF-8 -source 8 -target 8 -bootclasspath "$ANDROID_HOME/platforms/android-35/android.jar" -d /opt/codexa/classes /opt/codexa/MainActivity.java \
    && "$ANDROID_HOME/build-tools/35.0.0/d8" --lib "$ANDROID_HOME/platforms/android-35/android.jar" --min-api 23 --output /opt/codexa /opt/codexa/classes/com/codexa/wrapper/*.class

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
ENV NODE_ENV=production PORT=3000 ANDROID_HOME=/opt/android-sdk CODEXA_ANDROID_HOME=/opt/android-sdk CODEXA_TEMPLATE_DIR=/app/android-template CODEXA_CLASSES_DEX=/opt/codexa/classes.dex CODEXA_DEBUG_KEYSTORE=/app/android-template/codexa-debug.keystore CODEXA_GRADLE_BIN=/opt/gradle/bin/gradle CODEXA_BUILD_UID=10001 CODEXA_BUILD_GID=10001 CODEXA_BUILDER_HOME=/home/codexa-builder JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 codexa-builder \
    && useradd --uid 10001 --gid 10001 --home-dir /home/codexa-builder --create-home --shell /usr/sbin/nologin codexa-builder \
    && mkdir -p /home/codexa-builder/.gradle \
    && chown -R 10001:10001 /home/codexa-builder
COPY --from=web-build /app/dist ./dist
COPY server ./server
COPY android-template ./android-template
COPY --from=android-build /opt/android-sdk/build-tools/35.0.0/ /opt/android-sdk/build-tools/35.0.0/
COPY --from=android-build /opt/android-sdk/platforms/android-35/ /opt/android-sdk/platforms/android-35/
COPY --from=android-build /opt/android-sdk/licenses/ /opt/android-sdk/licenses/
COPY --from=android-build /opt/codexa/classes.dex /opt/codexa/classes.dex
COPY --from=android-build /opt/gradle-8.9 /opt/gradle-8.9
RUN ln -s /opt/gradle-8.9 /opt/gradle
EXPOSE 3000
CMD ["node", "server/index.mjs"]
