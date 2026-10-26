// Automatisches Deployment von OpenGrid.
// Bei jedem Push auf main: Syntax-Check + Unit-Tests, E2E-Tests (Playwright), danach
// `docker compose up -d --build` auf dem Host.
//
// Der Jenkins-Agent laeuft als Container auf demselben Host und nutzt den Docker-Daemon des Hosts ueber
// den eingehaengten Socket (/var/run/docker.sock). Pfade im Workspace existieren auf dem Host nicht, deshalb gibt es keine
// Bind-Mounts: Unit-Tests laufen als Image-Build (`Dockerfile.test`), E2E kopiert per `docker cp`.
//
// Voraussetzungen in Jenkins:
// - Agent-Container mit `-v /var/run/docker.sock:/var/run/docker.sock`; der Agent-Nutzer braucht Zugriff
//   auf den Socket (z. B. `--group-add <GID der docker-Gruppe des Hosts>`)
// - Docker-CLI: fehlt sie auf dem Agent, laedt `scripts/ci-env.sh` sie (plus Compose/Buildx) einmalig
//   nach `<workspace>@tools`; jeder Docker-Schritt bindet das Skript ein
// - Credential "open-grid-env" (Secret file): die Produktions-.env (TURN_*, VAPID_*, COMPOSE_PROFILES, ...)
// - GitHub-Webhook auf <jenkins>/github-webhook/ (GitHub-Plugin), sonst greift die Abfrage alle 5 Minuten
pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timeout(time: 60, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '30'))
    }

    triggers {
        githubPush()
        pollSCM('H/5 * * * *')
    }

    parameters {
        booleanParam(name: 'SKIP_E2E', defaultValue: false, description: 'E2E-Tests ueberspringen (nur im Notfall)')
    }

    environment {
        // Muss zum bisherigen Compose-Projekt passen, sonst entsteht ein zweites Projekt mit leerem Volume.
        COMPOSE_PROJECT_NAME = 'open-grid'
    }

    stages {
        stage('Version') {
            steps {
                script {
                    def count = sh(script: 'git rev-list --count HEAD', returnStdout: true).trim()
                    def hash = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                    env.BUILD_VERSION = "Build ${count} (${hash})"
                    env.BUILD_TIMESTAMP = sh(script: 'date -u +%Y-%m-%dT%H:%M:%SZ', returnStdout: true).trim()
                    currentBuild.displayName = "#${env.BUILD_NUMBER} ${env.BUILD_VERSION}"
                }
                sh '. scripts/ci-env.sh && docker version --format "Docker {{.Server.Version}}" && docker compose version'
            }
        }

        stage('Unit-Tests') {
            steps {
                sh '. scripts/ci-env.sh && docker build -f Dockerfile.test -t open-grid-test:${BUILD_NUMBER} .'
            }
            post {
                always {
                    sh '. scripts/ci-env.sh && docker image rm open-grid-test:${BUILD_NUMBER} >/dev/null 2>&1 || true'
                }
            }
        }

        stage('E2E-Tests') {
            when {
                expression { !params.SKIP_E2E }
            }
            steps {
                sh '. scripts/ci-env.sh && sh scripts/e2e.sh'
            }
        }

        stage('Deploy') {
            when {
                expression { (env.BRANCH_NAME ?: env.GIT_BRANCH ?: '').replaceFirst('^origin/', '') == 'main' }
            }
            steps {
                withCredentials([file(credentialsId: 'open-grid-env', variable: 'OPEN_GRID_ENV')]) {
                    sh '''
                        . scripts/ci-env.sh
                        docker compose --env-file "$OPEN_GRID_ENV" config --quiet
                        docker compose --env-file "$OPEN_GRID_ENV" up -d --build
                    '''
                }
                // Warten, bis der Healthcheck des neuen Containers gruen ist.
                sh '''
                    . scripts/ci-env.sh
                    cid=$(docker compose ps -q open-grid)
                    i=0
                    while [ "$(docker inspect -f '{{.State.Health.Status}}' "$cid")" != healthy ]; do
                        i=$((i + 1))
                        if [ "$i" -gt 40 ]; then
                            echo "open-grid wurde nicht healthy"
                            docker logs --tail 100 "$cid"
                            exit 1
                        fi
                        sleep 3
                    done
                    echo "open-grid healthy: $BUILD_VERSION"
                '''
            }
        }
    }

    post {
        success {
            sh '. scripts/ci-env.sh && docker image prune -f >/dev/null || true'
        }
    }
}
