import { createApp } from './app';
import { loadAppConfig } from './config/app-config';

const config = loadAppConfig();
const app = await createApp(config);
await app.listen(config.PORT);
