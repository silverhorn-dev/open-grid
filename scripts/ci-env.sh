# Wird von jedem sh-Schritt im Jenkinsfile eingebunden (`. scripts/ci-env.sh`).
# Hat der Jenkins-Agent keine Docker-CLI, werden statische Binaries (Docker-CLI, Compose, Buildx)
# einmalig nach `<workspace>@tools` geladen. Der Daemon ist der des Hosts (eingehaengter Socket).
DOCKER_CLI_VERSION=27.5.1
COMPOSE_VERSION=2.32.4
BUILDX_VERSION=0.20.1
CI_TOOLS="${WORKSPACE:-$PWD}@tools"
export PATH="$CI_TOOLS/bin:$PATH"
[ -d "$CI_TOOLS/docker-config/cli-plugins" ] && export DOCKER_CONFIG="$CI_TOOLS/docker-config"

ci_fetch() {
    if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
    else echo "Weder curl noch wget auf dem Agent" >&2; return 1
    fi
}

case "$(uname -m)" in
    x86_64|amd64) CI_ARCH=x86_64; CI_GOARCH=amd64 ;;
    aarch64|arm64) CI_ARCH=aarch64; CI_GOARCH=arm64 ;;
    *) echo "Nicht unterstuetzte Architektur: $(uname -m)" >&2; return 1 ;;
esac

if ! command -v docker >/dev/null 2>&1; then
    echo "Docker-CLI fehlt, lade $DOCKER_CLI_VERSION nach $CI_TOOLS"
    mkdir -p "$CI_TOOLS/bin"
    ci_fetch "https://download.docker.com/linux/static/stable/$CI_ARCH/docker-$DOCKER_CLI_VERSION.tgz" "$CI_TOOLS/docker.tgz"
    tar -xzf "$CI_TOOLS/docker.tgz" -C "$CI_TOOLS" docker/docker
    mv "$CI_TOOLS/docker/docker" "$CI_TOOLS/bin/docker"
    rm -rf "$CI_TOOLS/docker" "$CI_TOOLS/docker.tgz"
fi

if ! docker compose version >/dev/null 2>&1 || ! docker buildx version >/dev/null 2>&1; then
    export DOCKER_CONFIG="$CI_TOOLS/docker-config"
    mkdir -p "$DOCKER_CONFIG/cli-plugins"
    if [ ! -x "$DOCKER_CONFIG/cli-plugins/docker-compose" ]; then
        echo "Docker Compose fehlt, lade $COMPOSE_VERSION"
        ci_fetch "https://github.com/docker/compose/releases/download/v$COMPOSE_VERSION/docker-compose-linux-$CI_ARCH" "$DOCKER_CONFIG/cli-plugins/docker-compose"
        chmod +x "$DOCKER_CONFIG/cli-plugins/docker-compose"
    fi
    if [ ! -x "$DOCKER_CONFIG/cli-plugins/docker-buildx" ]; then
        echo "Docker Buildx fehlt, lade $BUILDX_VERSION"
        ci_fetch "https://github.com/docker/buildx/releases/download/v$BUILDX_VERSION/buildx-v$BUILDX_VERSION.linux-$CI_GOARCH" "$DOCKER_CONFIG/cli-plugins/docker-buildx"
        chmod +x "$DOCKER_CONFIG/cli-plugins/docker-buildx"
    fi
fi
