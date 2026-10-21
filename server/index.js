import { buildApp } from './app.js';

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT) || 3000;
const app = await buildApp({ logger: true });

try {
    await app.listen({ host, port });
} catch (error) {
    app.log.error(error);
    process.exit(1);
}
