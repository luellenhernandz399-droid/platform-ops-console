// 启动入口：npm start

import { PlatformConsole } from './app.ts';
import { createServer } from './api/server.ts';
import { systemClock } from './domain/time.ts';
import { seed } from './dev/seed.ts';

const app = new PlatformConsole(systemClock);
const port = Number(process.env.PORT ?? 8080);

// 演示数据。SEED=0 可关闭，用于跑空库。
if (process.env.SEED !== '0') {
  seed(app);
  console.log(`已载入演示数据：${app.store.tenants.count()} 个租户`);
}

createServer(app).listen(port, () => {
  console.log(`平台运营后台：http://localhost:${port}`);
  console.log(`API：        http://localhost:${port}/platform/v1`);
});
