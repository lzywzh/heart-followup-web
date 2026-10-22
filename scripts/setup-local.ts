import 'dotenv/config';
import { ensureDatabaseLink } from './database-link.js';
import { provisionAccount } from './admin.js';
import { createDatabase } from '../apps/api/src/db/database.js';
import { migrate } from '../apps/api/src/db/migrate.js';
if(process.env.NODE_ENV==='production')throw new Error('本地初始化不适用于生产环境');
await ensureDatabaseLink();const db=createDatabase(process.env.MIGRATION_DATABASE_URL||process.env.DATABASE_URL!);
try{await migrate(db);}finally{await db.close();}
for(const [role,username,name]of [['admin','platform_admin','平台管理员'],['clinician','doctor','负责医生']] as const){const path=await provisionAccount(role,username,name);if(path)console.log('账户凭据文件：'+path);}
console.log('本地初始化完成。未创建任何患者或测试病历。运行 npm run dev 启动。');
