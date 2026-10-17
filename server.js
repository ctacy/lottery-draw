import { createApp } from './src/app.js';
import { lanAddresses } from './src/util.js';

const PORT = Number(process.env.PORT) || 8201;
const HOST = process.env.HOST || '0.0.0.0';

const { app, db, hub, initialPassword } = createApp({
  dataDir: process.env.DATA_DIR || 'data',
  adminPassword: process.env.ADMIN_PASSWORD,
  secureCookie: process.env.COOKIE_SECURE === '1',
  trustProxy: process.env.TRUST_PROXY === '1' ? 1 : false,
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\n抽奖系统已启动，端口 ${PORT}`);
  console.log(`  后台管理  http://localhost:${PORT}/admin/`);
  console.log(`  抽奖大屏  http://localhost:${PORT}/screen/`);
  for (const { address } of lanAddresses()) console.log(`  扫码签到  http://${address}:${PORT}/m/`);
  if (initialPassword) {
    console.log('\n  首次启动已创建管理员：admin');
    console.log(`  初始密码：${initialPassword}`);
    console.log('  （仅显示这一次，请登录后立即在「系统设置」中修改）\n');
  }
});

function shutdown() {
  hub.closeAll();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
