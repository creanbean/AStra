import 'dotenv/config';
import { createApp } from './app.js';

const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.ASTRA_ACCESS_TOKEN) {
  throw new Error('Set ASTRA_ACCESS_TOKEN before exposing the app beyond localhost.');
}
const { app, close } = await createApp();
const server = app.listen(Number(process.env.PORT || 3000), host, () => console.log(`AStra server listening on ${host}:${process.env.PORT || 3000}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => {
  server.close();
  await close();
  process.exit(0);
});
