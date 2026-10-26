# Self-hosting

${term.app} is ${term.openSource}. Any group, club or event can run its own server. That server stores no chats – it only connects people.

## What you need

- A small server or a home device with **Docker**.
- A **domain** with HTTPS (e.g. through a reverse proxy or a Cloudflare tunnel).
- Optionally a ${term.turn} so connections also work on difficult networks. It is already included.

## In three steps

1. Download the project and copy the template `.env.example` to `.env`.
2. Enter your domain, TURN secret and push contact in `.env`.
3. Run `docker compose up -d --build`.

The app then runs on your domain. This info site appears under `/info` – or on its own subdomain if you set `INFO_HOST`.

## What you can configure

- Which **modes** are available (e.g. chat only for a private circle).
- **Defaults** for your users' settings, such as the language.
- A **club mode** for events without internet: connections only on the local Wi-Fi.

## What the operator sees – and what not

Even as the operator you don't see messages, photos or full profiles. The server only stores short-lived grid entries (name, preview picture, ${term.aCell}) and encrypted messages for people who are offline right now.

Technical details are in the project's README.
