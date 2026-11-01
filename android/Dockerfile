# Build-Umgebung fuer die Android-App (android/build.sh): JDK 17, Gradle, Android-SDK ohne Android Studio.
FROM eclipse-temurin:17-jdk-jammy
ARG CMDLINE_TOOLS=11076708
ARG GRADLE_VERSION=8.9
ENV ANDROID_HOME=/opt/android-sdk \
    GRADLE_USER_HOME=/cache/gradle
RUN apt-get update && apt-get install -y --no-install-recommends unzip wget && rm -rf /var/lib/apt/lists/* \
    && mkdir -p $ANDROID_HOME/cmdline-tools \
    && wget -q -O /tmp/tools.zip https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip \
    && unzip -q /tmp/tools.zip -d $ANDROID_HOME/cmdline-tools && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
    && rm /tmp/tools.zip \
    && yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null \
    && $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-34" "build-tools;34.0.0" >/dev/null \
    && wget -q -O /tmp/gradle.zip https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip \
    && unzip -q /tmp/gradle.zip -d /opt && ln -s /opt/gradle-${GRADLE_VERSION}/bin/gradle /usr/local/bin/gradle \
    && rm /tmp/gradle.zip
WORKDIR /src
